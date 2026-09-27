import { randomUUID } from 'node:crypto';
import type { Batch, ExtractionResult, ProductInput } from '../shared/types.js';
import { parseProductInput } from '../shared/input.js';
import { productUrl } from './urls.js';
import { cleanHtml, textOnly } from './adapters/common.js';

export function buildBatch(input: string[] | string): Batch {
  const requests: ProductInput[] = typeof input === 'string' ? parseProductInput(input) : input.map(url => ({ url }));
  if (!requests.length || requests.length > 50) throw new Error('Paste between 1 and 50 product links.');
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
        } else delete existing.selection;
        continue;
      }
      const item: ExtractionResult = { id, url: normalized.url, selection, retailer: normalized.retailer, status: 'queued' };
      seen.set(key, item); items.push(item);
    } catch (error) { items.push({ id, url: raw, selection, status: 'failed', error: (error as Error).message }); }
  }
  return { id: randomUUID(), createdAt: new Date().toISOString(), items, duplicates, cancelled: false, running: items.some(i => i.status === 'queued') };
}

export function deduplicateProduct(batch: Batch, item: ExtractionResult) {
  const existing = batch.items.find(i => i.id !== item.id && i.status === 'success' && i.product?.id === item.product?.id && i.product?.included);
  if (!existing) return;
  if (item.selection || existing.selection) {
    const issue = 'Multiple links resolved to this product and colour with size notes. Combine the size notes under one link and collect again before CSV export.';
    for (const p of [existing.product!, item.product!]) {
      p.selectionErrors = [...(p.selectionErrors ?? []), issue]; p.warnings.push(issue);
    }
  }
  item.product!.included = false;
  item.product!.warnings.push('This product and color already appear in this batch. Duplicate excluded.');
}

export function editProduct(item: ExtractionResult, patch: Record<string, unknown>) {
  if (!item.product || item.status !== 'success') throw new Error('Only extracted products can be edited.');
  const product = item.product;
  for (const field of ['title', 'brand', 'productType', 'description'] as const) if (field in patch) {
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
}
