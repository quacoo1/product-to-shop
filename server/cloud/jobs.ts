import { randomUUID } from 'node:crypto';
import { load } from 'cheerio';
import type { Batch, ExtractionResult, Product } from '../../shared/types.js';
import { buildBatch, deduplicateProduct, editProduct } from '../batch.js';
import { extract, validateImages } from '../extract.js';
import { parseProduct } from '../adapters/index.js';
import { productUrl } from '../urls.js';
import { resolveProductLink } from '../resolve-link.js';
import { applySelection, withRequestedColor } from '../selection.js';
import { HttpError, type Store } from './store.js';

export interface SavedBatch {
  batch: Batch;
  leases: Record<string, { token: string; until: number }>;
  attempts: Record<string, number>;
}
const LEASE_MS = 210000;
const WORK_MS = 180000;
function itemIn(batch: Batch, id: string) {
  const item = batch.items.find(i => i.id === id);
  if (!item) throw new HttpError(404, 'Product not found.');
  return item;
}
function running(batch: Batch) { batch.running = batch.items.some(i => ['queued', 'extracting'].includes(i.status)); }

export class CloudJobs {
  constructor(private store: Store, private extractor = extract, private imageValidator = validateImages,
    private resolver = resolveProductLink, private now = Date.now) {}
  private key(owner: string, id: string) { return `batch:${owner}:${id}`; }
  async create(owner: string, input: string[] | string): Promise<Batch> {
    const batch = buildBatch(input);
    if (await this.store.count(`create:${owner}`, 3600) > 20) throw new HttpError(429, 'Up to 20 batches can be started per hour. Try again later.');
    await this.store.put<SavedBatch>(this.key(owner, batch.id), { batch, leases: {}, attempts: {} });
    return batch;
  }
  async get(owner: string, id: string): Promise<Batch> {
    const saved = await this.store.get<SavedBatch>(this.key(owner, id));
    if (!saved) throw new HttpError(404, 'Batch not found or expired. Collections are retained for seven days.');
    return saved.batch;
  }
  private async update(owner: string, id: string, change: (saved: SavedBatch) => void) {
    return (await this.store.update<SavedBatch>(this.key(owner, id), saved => { change(saved); running(saved.batch); })).batch;
  }
  async cancel(owner: string, id: string) {
    return this.update(owner, id, saved => {
      saved.batch.cancelled = true;
      for (const item of saved.batch.items) if (['queued', 'extracting'].includes(item.status)) item.status = 'cancelled';
      saved.leases = {}; // An in-flight worker can no longer commit its result.
    });
  }
  async retry(owner: string, id: string, itemId: string) {
    return this.update(owner, id, saved => {
      const item = itemIn(saved.batch, itemId);
      if (['queued', 'extracting'].includes(item.status)) throw new HttpError(409, 'This link is already being processed.');
      const normalized = productUrl(item.url);
      item.url = normalized.url; item.retailer = normalized.retailer;
      item.status = 'queued'; delete item.error; delete item.product;
      saved.attempts[itemId] = 0; saved.batch.cancelled = false;
    });
  }
  async edit(owner: string, id: string, itemId: string, patch: Record<string, unknown>) {
    return this.update(owner, id, saved => editProduct(itemIn(saved.batch, itemId), patch));
  }
  private async recover(owner: string, id: string) {
    const saved = await this.store.get<SavedBatch>(this.key(owner, id));
    if (!saved) throw new HttpError(404, 'Batch not found or expired.');
    if (!Object.values(saved.leases).some(l => l.until <= this.now())) return saved.batch;
    return this.update(owner, id, record => {
      for (const [itemId, lease] of Object.entries(record.leases)) {
        if (lease.until > this.now()) continue;
        const item = itemIn(record.batch, itemId);
        if (item.status === 'extracting') {
          item.status = record.batch.cancelled ? 'cancelled' : (record.attempts[itemId] ?? 0) >= 3 ? 'needs_browser' : 'queued';
          item.error = 'The previous extraction stopped before finishing. Retry or upload the saved product page.';
        }
        delete record.leases[itemId];
      }
    });
  }
  // Each HTTP invocation processes one product. Polling resumes queued work after a cold start.
  async process(owner: string, id: string, upload?: { itemId: string; html: string; sourceUrl: string }): Promise<Batch> {
    const batch = await this.recover(owner, id);
    const candidates = upload ? [itemIn(batch, upload.itemId)] : batch.items.filter(i => i.status === 'queued' && i.retailer);
    for (const candidate of candidates) {
      if (!candidate.retailer) throw new HttpError(400, 'Use a valid product link before uploading a page.');
      if (upload && ['queued', 'extracting'].includes(candidate.status)) throw new HttpError(409, 'Wait for automatic extraction to finish first.');
      const token = randomUUID();
      let slot: string | undefined;
      for (const name of ['worker:0', 'worker:1']) if (await this.store.acquire(name, token, LEASE_MS)) { slot = name; break; }
      if (!slot) break;
      const retailerLock = `retailer:${candidate.retailer}`;
      let retailerAcquired = false;
      try {
        retailerAcquired = await this.store.acquire(retailerLock, token, LEASE_MS);
        if (!retailerAcquired) continue;
        const claimed = await this.store.update<SavedBatch>(this.key(owner, id), record => {
          const item = itemIn(record.batch, candidate.id);
          if (upload ? ['queued', 'extracting'].includes(item.status) : item.status !== 'queued' || record.batch.cancelled) return;
          record.leases[item.id] = { token, until: this.now() + LEASE_MS };
          record.attempts[item.id] = (record.attempts[item.id] ?? 0) + 1;
          item.status = 'extracting'; delete item.error;
          record.batch.cancelled = false; running(record.batch);
        });
        if (claimed.leases[candidate.id]?.token !== token) continue;
        const signal = AbortSignal.timeout(WORK_MS);
        let product: Product | undefined;
        let error: string | undefined;
        try {
          const resolvedUrl = candidate.resolvedUrl || await this.resolver(candidate.url, signal);
          await this.update(owner, id, record => {
            if (record.leases[candidate.id]?.token === token) itemIn(record.batch, candidate.id).resolvedUrl = resolvedUrl;
          });
          if (upload) {
            const source = productUrl(upload.sourceUrl);
            if (source.retailer !== candidate.retailer || new URL(source.url).pathname !== new URL(resolvedUrl).pathname) {
              throw new Error('The saved page must be from this same product. For an unresolved share link, create a new batch using its full product URL.');
            }
            const $ = load(upload.html);
            const canonical = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content');
            if (canonical) {
              const htmlSource = productUrl(new URL(canonical, source.url).href);
              if (htmlSource.retailer !== source.retailer || new URL(htmlSource.url).pathname !== new URL(source.url).pathname) throw new Error('This HTML file belongs to a different product.');
            }
            // Uploaded scripts are parsed as text; no uploaded code is ever executed.
            product = parseProduct(upload.html, withRequestedColor(resolvedUrl, candidate.selection?.color), candidate.retailer);
            await this.imageValidator(product, signal);
          } else product = await this.extractor(resolvedUrl, candidate.retailer, signal, candidate.selection?.color);
          signal.throwIfAborted();
          product = applySelection(product, candidate.selection);
        } catch (failure) {
          error = signal.aborted ? 'Extraction exceeded three minutes. Retry or upload the saved product page.' : failure instanceof Error ? failure.message : 'Extraction failed.';
        }
        return await this.update(owner, id, record => {
          if (record.leases[candidate.id]?.token !== token) return;
          const item = itemIn(record.batch, candidate.id);
          delete record.leases[item.id];
          if (error) { item.status = 'needs_browser'; item.error = error; }
          else { item.product = product; item.status = 'success'; delete item.error; deduplicateProduct(record.batch, item); }
        });
      } finally {
        await this.store.release(slot, token);
        if (retailerAcquired) await this.store.release(retailerLock, token);
      }
    }
    if (upload) throw new HttpError(409, 'Extraction is busy. Retry the upload when active products finish.');
    return this.get(owner, id);
  }
}
