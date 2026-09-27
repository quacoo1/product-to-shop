import archiver from 'archiver';
import type { Writable } from 'node:stream';
import type { Batch, Product, Variant } from '../shared/types.js';
import { RETAILER_VENDORS } from '../shared/types.js';
import { selectedProducts } from './jobs.js';
import { fetchImage } from './network.js';
import { slug } from './urls.js';

const SHOPIFY_VARIANT_DEFAULTS = { inventoryTracker: 'shopify', inventoryPolicy: 'deny', fulfillmentService: 'manual' } as const;
export const CSV_HEADERS = ['URL handle','Title','Description','Vendor','Type','Published on online store','Status','Option1 name','Option1 value','Option2 name','Option2 value','SKU','Inventory tracker','Continue selling when out of stock','Fulfillment service','Product image URL','Image position','Image alt text'];
export const csvReady = (product: Product) => !!product.title.trim() && product.variants.length > 0 && !product.selectionErrors?.length;
export const INVENTORY_HEADERS = ['Handle','Title','Option 1 Name','Option 1 Value','Option 2 Name','Option 2 Value','Option 3 Name','Option 3 Value','SKU','Location','On hand (current)','On hand (new)'];
function variantOptions(product: Product, variant?: Variant): unknown[] {
  if (!variant) return ['', '', '', ''];
  const hasSize = product.variants.some(v => v.size);
  const hasColor = product.variants.some(v => v.color);
  return [hasSize ? 'Size' : hasColor ? 'Color' : 'Title',
    hasSize ? variant.size : hasColor ? variant.color : 'Default Title',
    hasSize && hasColor ? 'Color' : '', hasSize && hasColor ? variant.color : ''];
}
function exportProducts(batch: Batch) {
  const products = selectedProducts(batch);
  if (!products.length) throw new Error('Select at least one extracted product.');
  const incomplete = products.filter(p => !csvReady(p));
  if (incomplete.length) throw new Error(`Verify sizes, quantities and a title, or exclude these products before CSV export: ${incomplete.map(p => p.title || p.sourceId).join(', ')}`);
  return products;
}
function cell(value: unknown) {
  let text = value == null ? '' : String(value);
  // Protect spreadsheet users while retaining ordinary numeric size labels.
  if (/^[\t\r\n ]*[=+@]/.test(text) || /^[\t\r\n ]*-(?!\d+(?:\.\d+)?$)/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
export function toCsv(batch: Batch): string {
  const products = exportProducts(batch);
  const rows: unknown[][] = [CSV_HEADERS];
  for (const p of products) {
    const images = p.images.filter(i => i.included && i.validation === 'valid');
    const count = Math.max(p.variants.length, images.length);
    for (let i = 0; i < count; i++) {
      const variant = p.variants[i]; const image = images[i];
      rows.push([p.handle, i ? '' : p.title, i ? '' : p.description, i ? '' : RETAILER_VENDORS[p.retailer], i ? '' : p.productType,
        i ? '' : 'false', i ? '' : 'draft',
        ...variantOptions(p, variant), variant?.sku ?? '',
        variant ? SHOPIFY_VARIANT_DEFAULTS.inventoryTracker : '',
        variant ? SHOPIFY_VARIANT_DEFAULTS.inventoryPolicy : '',
        variant ? SHOPIFY_VARIANT_DEFAULTS.fulfillmentService : '',
        image?.url ?? '', image ? i + 1 : '', image?.alt ?? '',
      ]);
    }
  }
  return rows.map(row => row.map(cell).join(',')).join('\n') + '\n';
}
export function toInventoryCsv(batch: Batch, location: unknown): string {
  if (typeof location !== 'string' || !location.trim() || location.length > 255 || /[\x00-\x1f\x7f]/.test(location) || /^[\s]*[=+@-]/.test(location)) {
    throw new Error('Enter the exact Shopify location name (1–255 characters, without control characters or a formula prefix).');
  }
  const rows: unknown[][] = [INVENTORY_HEADERS];
  for (const product of exportProducts(batch)) {
    for (const variant of product.variants) {
      // Compare against an unstocked location so importing cannot silently reset existing stock.
      rows.push([product.handle, product.title, ...variantOptions(product, variant), '', '', variant.sku ?? '', location.trim(), 'not stocked', variant.requestedQuantity ?? 0]);
    }
  }
  return rows.map(row => row.map(cell).join(',')).join('\n') + '\n';
}
export function toJson(batch: Batch) {
  return {
    schemaVersion: '1.1', exportedAt: new Date().toISOString(), format: 'product-collector',
    note: 'Structured data for integrations. Import the CSV into Shopify. Products are drafts with Shopify inventory tracking enabled; set your own prices and stock quantities before publishing.',
    products: selectedProducts(batch).map(p => ({ ...p, vendor: RETAILER_VENDORS[p.retailer], variants: p.variants.map(v => ({ ...v, ...SHOPIFY_VARIANT_DEFAULTS })), images: p.images.filter(i => i.included) })),
    errors: batch.items.filter(i => i.status !== 'success').map(i => ({ url: i.url, status: i.status, error: i.error ?? (i.status === 'cancelled' ? 'Cancelled.' : 'Not extracted yet.') })),
  };
}
export async function writeZip(batch: Batch, output: Writable, signal: AbortSignal, download = fetchImage) {
  const products = structuredClone(selectedProducts(batch));
  if (!products.length) throw new Error('Select at least one extracted product.');
  const archive = archiver('zip', { zlib: { level: 1 } });
  let failure: Error | undefined;
  archive.on('error', error => { failure = error; output.destroy(error); });
  const abort = () => { archive.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  archive.pipe(output);
  const manifest: { sourceUrl: string; product: string; imageUrl: string; file?: string; error?: string }[] = [];
  let totalBytes = 0;
  try {
    for (const product of products) {
      for (const [index, image] of product.images.filter(i => i.included).entries()) {
        signal.throwIfAborted(); if (failure) throw failure;
        try {
          if (totalBytes >= 300 * 1024 * 1024) throw new Error('ZIP reached the 300 MB batch limit. Export fewer products.');
          const data = await download(image.url, signal);
          if (totalBytes + data.bytes.length > 300 * 1024 * 1024) throw new Error('ZIP reached the 300 MB batch limit.');
          totalBytes += data.bytes.length;
          const file = `${product.handle}/${String(index + 1).padStart(2, '0')}-${slug(product.title).slice(0, 50) || 'image'}.${data.extension}`;
          archive.append(data.bytes, { name: file });
          manifest.push({ sourceUrl: product.sourceUrl, product: product.title, imageUrl: image.url, file });
        } catch (error) { signal.throwIfAborted(); manifest.push({ sourceUrl: product.sourceUrl, product: product.title, imageUrl: image.url, error: (error as Error).message }); }
      }
    }
    archive.append(JSON.stringify({ schemaVersion: '1.0', images: manifest }, null, 2), { name: 'manifest.json' });
    await archive.finalize();
    if (failure) throw failure;
  } finally { signal.removeEventListener('abort', abort); }
}
