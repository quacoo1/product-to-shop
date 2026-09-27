import { randomUUID } from 'node:crypto';
import type { Batch, ExtractionResult, Product, ProductInput, Retailer } from '../shared/types.js';
import { parseProductInput } from '../shared/input.js';
import { applySelection, withRequestedColor } from './selection.js';
import { extract, validateImages } from './extract.js';
import { shortLinkRetailer, productUrl } from './urls.js';
import { cleanHtml, textOnly } from './adapters/common.js';
import { parseProduct } from './adapters/index.js';
import { openProductBrowser, type BrowserSession } from './browser.js';

type Extractor = typeof extract;
interface Runtime { batch: Batch; controllers: Map<string, AbortController>; active: Set<string>; }
export class Jobs {
  private records = new Map<string, Runtime>();
  private browser?: { batchId: string; itemId: string; session: BrowserSession; timer: ReturnType<typeof setTimeout>; controller: AbortController };
  private reservations = new Set<Retailer>();
  private activeCount = 0;
  private startingBrowser = false;
  constructor(private extractor: Extractor = extract, private browserFactory = openProductBrowser, private imageValidator = validateImages) {}
  create(input: string[] | string) {
    const requests: ProductInput[] = typeof input === 'string' ? parseProductInput(input) : input.map(url => ({ url }));
    if (!requests.length || requests.length > 50) throw new Error('Paste between 1 and 50 product links.');
    if (this.records.size >= 20) {
      const old = [...this.records.values()].find(r => !r.batch.running);
      if (old) this.records.delete(old.batch.id); else throw new Error('Finish or cancel an existing batch first.');
    }
    const seen = new Map<string, ExtractionResult>();
    let duplicates = 0;
    const items: ExtractionResult[] = [];
    for (const { url: raw, selection } of requests) {
      const id = randomUUID();
      try {
        const normalized = productUrl(raw);
        const key = `${normalized.key}|${selection?.color?.toLowerCase().replace(/[-_\s]+/g, '') ?? ''}`;
        const existing = seen.get(key);
        if (existing) {
          duplicates++;
          if (existing.selection && selection) {
            if (JSON.stringify(existing.selection) !== JSON.stringify(selection)) {
              existing.selection.sizes.push(...selection.sizes);
              existing.selection.notes.push(...selection.notes);
              existing.selection.quantityChecks = [...(existing.selection.quantityChecks ?? []), ...(selection.quantityChecks ?? [])];
            }
          } else delete existing.selection; // A plain link requests every size.
          continue;
        }
        const item: ExtractionResult = { id, url: normalized.url, selection, retailer: normalized.retailer, status: 'queued' };
        seen.set(key, item); items.push(item);
      } catch (error) { items.push({ id, url: raw, selection, status: 'failed', error: (error as Error).message }); }
    }
    const batch: Batch = { id: randomUUID(), createdAt: new Date().toISOString(), items, duplicates, cancelled: false, running: true };
    this.records.set(batch.id, { batch, active: new Set(), controllers: new Map() });
    this.pump();
    return batch;
  }
  get(id: string) { const value = this.records.get(id); if (!value) throw new Error('Batch not found. Batches are cleared when the app restarts.'); return value; }
  item(batchId: string, itemId: string) { const item = this.get(batchId).batch.items.find(i => i.id === itemId); if (!item) throw new Error('Product not found.'); return item; }
  private pump() {
    for (const runtime of this.records.values()) {
      for (const item of runtime.batch.items) {
        if (this.activeCount >= 2) break;
        if (item.status !== 'queued' || !item.retailer || this.reservations.has(item.retailer)) continue;
        const controller = new AbortController();
        runtime.controllers.set(item.id, controller); runtime.active.add(item.id);
        this.reservations.add(item.retailer); this.activeCount++; item.status = 'extracting'; delete item.error;
        void this.extractor(item.url, item.retailer, controller.signal, item.selection?.color).then(product => {
          if (!controller.signal.aborted) { item.product = applySelection(product, item.selection); item.status = 'success'; this.deduplicate(runtime.batch, item); }
        }).catch(error => {
          if (!controller.signal.aborted) { item.status = 'needs_browser'; item.error = (error as Error).message; }
        }).finally(() => {
          if (controller.signal.aborted) item.status = 'cancelled';
          this.activeCount--; this.reservations.delete(item.retailer!); runtime.active.delete(item.id); runtime.controllers.delete(item.id); this.pump();
        });
      }
      runtime.batch.running = runtime.batch.items.some(i => ['queued','extracting','awaiting_user'].includes(i.status));
    }
  }
  private deduplicate(batch: Batch, item: ExtractionResult) {
    const existing = batch.items.find(i => i.id !== item.id && i.status === 'success' && i.product?.id === item.product?.id && i.product?.included);
    if (existing) {
      if (item.selection || existing.selection) {
        // Different share links may resolve to the same product. Never silently discard an order.
        const issue = 'Multiple links resolved to this product and colour with size notes. Combine the size notes under one link and collect again before CSV export.';
        existing.product!.selectionErrors = [...(existing.product!.selectionErrors ?? []), issue];
        existing.product!.warnings.push(issue);
        item.product!.selectionErrors = [...(item.product!.selectionErrors ?? []), issue];
        item.product!.warnings.push(issue);
      }
      item.product!.included = false; item.product!.warnings.push('This product and color already appear in this batch. Duplicate excluded.');
    }
  }
  async cancel(id: string) {
    const runtime = this.get(id);
    runtime.batch.cancelled = true;
    for (const item of runtime.batch.items) if (['queued','extracting','awaiting_user'].includes(item.status)) item.status = 'cancelled';
    for (const controller of runtime.controllers.values()) controller.abort();
    if (this.browser?.batchId === id) await this.closeBrowser();
    this.pump();
    return runtime.batch;
  }
  retry(batchId: string, itemId: string) {
    const runtime = this.get(batchId); const item = this.item(batchId, itemId);
    if (runtime.active.has(itemId) || ['queued','extracting','awaiting_user'].includes(item.status)) throw new Error('This link is already being processed.');
    const normalized = productUrl(item.url); item.retailer = normalized.retailer; item.url = normalized.url;
    item.status = 'queued'; delete item.error; runtime.batch.cancelled = false; this.pump();
    return runtime.batch;
  }
  update(batchId: string, itemId: string, patch: Record<string, unknown>) {
    const item = this.item(batchId, itemId);
    if (!item.product || item.status !== 'success') throw new Error('Only extracted products can be edited.');
    const product = item.product;
    for (const field of ['title','brand','productType','description'] as const) if (field in patch) {
      if (typeof patch[field] !== 'string' || (patch[field] as string).length > (field === 'description' ? 30000 : 500)) throw new Error(`Invalid ${field}.`);
      product[field] = field === 'description' ? cleanHtml(patch[field] as string) : textOnly(patch[field] as string);
    }
    if ('included' in patch) { if (typeof patch.included !== 'boolean') throw new Error('Invalid product selection.'); product.included = patch.included; }
    if ('images' in patch) {
      if (!Array.isArray(patch.images)) throw new Error('Invalid image selection.');
      for (const image of patch.images) {
        if (!image || typeof image.id !== 'string' || typeof image.included !== 'boolean') throw new Error('Invalid image selection.');
        const known = product.images.find(i => i.id === image.id); if (known) known.included = image.included;
      }
    }
    return this.get(batchId).batch;
  }
  async beginBrowser(batchId: string, itemId: string) {
    if (this.browser || this.startingBrowser) throw new Error('Finish or close the current assisted browser first.');
    const runtime = this.get(batchId); const item = this.item(batchId, itemId);
    if (!item.retailer || runtime.active.has(itemId) || ['queued','extracting','awaiting_user'].includes(item.status)) throw new Error('Wait for this link to finish before opening a browser.');
    if (this.reservations.has(item.retailer) || this.activeCount >= 2) throw new Error('Extraction is busy. Try again when the active links finish.');
    this.startingBrowser = true; this.reservations.add(item.retailer); this.activeCount++;
    const controller = new AbortController(); runtime.controllers.set(item.id, controller);
    item.status = 'extracting'; runtime.batch.running = true;
    try {
      const session = await this.browserFactory(item.url, true, controller.signal, item.selection?.color);
      controller.signal.throwIfAborted();
      const timer = setTimeout(() => { void this.endBrowser(batchId, itemId, 'Browser session expired after 5 minutes. Retry when ready.'); }, 5 * 60 * 1000);
      this.browser = { batchId, itemId, session, timer, controller };
      item.status = 'awaiting_user'; delete item.error;
      session.browser.on('disconnected', () => { if (this.browser?.itemId === itemId) void this.endBrowser(batchId, itemId, 'Browser closed. Retry when ready.'); });
    } catch (error) {
      item.status = controller.signal.aborted ? 'cancelled' : 'needs_browser'; item.error = (error as Error).message;
      runtime.controllers.delete(item.id); this.reservations.delete(item.retailer); this.activeCount--;
    } finally { this.startingBrowser = false; this.pump(); }
    return runtime.batch;
  }
  async resumeBrowser(batchId: string, itemId: string) {
    const current = this.browser;
    if (!current || current.batchId !== batchId || current.itemId !== itemId) throw new Error('No assisted browser is open for this link.');
    const item = this.item(batchId, itemId);
    if (item.status !== 'awaiting_user') throw new Error('Browser extraction is already running.');
    item.status = 'extracting';
    try {
      const final = productUrl(current.session.page.url());
      if (final.retailer !== item.retailer) throw new Error('Return to the original product page before continuing.');
      if (new URL(final.url).pathname !== new URL(current.session.entryUrl).pathname) throw new Error('Return to the original product page before continuing.');
      // Parse using the original link so its color selection remains authoritative.
      const sourceUrl = withRequestedColor(shortLinkRetailer(new URL(item.url)) ? productUrl(current.session.entryUrl).url : item.url, item.selection?.color);
      const product = parseProduct(await current.session.page.content(), sourceUrl, item.retailer!);
      await this.imageValidator(product, current.controller.signal);
      current.controller.signal.throwIfAborted();
      item.product = applySelection(product, item.selection); item.status = 'success'; delete item.error; this.deduplicate(this.get(batchId).batch, item);
    } catch (error) { item.status = current.controller.signal.aborted ? 'cancelled' : 'needs_browser'; item.error = (error as Error).message; }
    finally { await this.closeBrowser(); this.pump(); }
    return this.get(batchId).batch;
  }
  async endBrowser(batchId: string, itemId: string, message = 'Browser retry cancelled.') {
    if (this.browser?.batchId !== batchId || this.browser.itemId !== itemId) throw new Error('No matching browser session.');
    const item = this.item(batchId, itemId); item.status = 'needs_browser'; item.error = message;
    await this.closeBrowser(); this.pump(); return this.get(batchId).batch;
  }
  private async closeBrowser() {
    const current = this.browser; if (!current) return;
    this.browser = undefined; clearTimeout(current.timer); current.controller.abort();
    const item = this.item(current.batchId, current.itemId);
    this.reservations.delete(item.retailer!); this.activeCount--; this.get(current.batchId).controllers.delete(current.itemId);
    await current.session.close();
  }
  async shutdown() { for (const id of this.records.keys()) await this.cancel(id); }
}
export const selectedProducts = (batch: Batch): Product[] => {
  const products = batch.items.filter(i => i.status === 'success' && i.product?.included).map(i => i.product!);
  return [...new Map(products.map(p => [p.id, p])).values()];
};
