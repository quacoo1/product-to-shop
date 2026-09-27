import type { Product, RequestedSelection } from '../shared/types.js';
import { sameColor } from './adapters/common.js';
import { quantityErrors } from '../shared/input.js';

export function withRequestedColor(input: string, color?: string): string {
  if (!color) return input;
  const url = new URL(input);
  for (const key of [...url.searchParams.keys()]) {
    if (['colour', 'color', 'colourwayid', 'colorwayid'].includes(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.set('colour', color);
  return url.href;
}

// Bare numeric retailer labels are UK sizes only on a UK storefront.
function sizeKey(size: string, allowBare: boolean): string | undefined {
  const match = /^UK\s*(\d{1,2})$/i.exec(size.trim()) ?? (allowBare ? /^(\d{1,2})$/.exec(size.trim()) : null);
  return match ? String(Number(match[1])) : undefined;
}
export function applySelection(product: Product, selection?: RequestedSelection): Product {
  if (!selection) return product;
  product.requestedSelection = structuredClone(selection);
  const url = new URL(product.sourceUrl);
  const country = url.searchParams.get('country');
  const ukStore = (!country || /^(GB|UK)$/i.test(country)) &&
    !/^(us|au|ca|eu|fr|ie)\./i.test(url.hostname) && !/\.(us|au|fr|ie|ae)$/.test(url.hostname) &&
    !/^\/(us|au|ca|eu|fr|ie)(\/|$)/i.test(url.pathname) &&
    (!url.searchParams.get('currency') || url.searchParams.get('currency') === 'GBP') && !url.searchParams.has('store');
  const errors = quantityErrors(selection);
  if (selection.color && (!product.color || !sameColor(product.color, selection.color))) errors.push(`Requested colour ${selection.color} could not be verified.`);
  const requested = new Set(selection.sizes.map(size => sizeKey(size, true)));
  product.variants = product.variants.filter(v => requested.has(sizeKey(v.size ?? '', ukStore)) &&
    (!selection.color || sameColor(v.color || product.color || '', selection.color)));
  for (const variant of product.variants) {
    variant.requestedQuantity = selection.sizes.filter(size => sizeKey(size, true) === sizeKey(variant.size ?? '', ukStore)).length;
  }
  for (const size of new Set(selection.sizes)) {
    if (!product.variants.some(v => sizeKey(v.size ?? '', ukStore) === sizeKey(size, true))) errors.push(`Requested size ${size} was not found${selection.color ? ` in ${selection.color}` : ''}.`);
  }
  product.selectionErrors = errors;
  product.warnings.push(`Requested: ${selection.notes.join(' · ')}. Each listed size counts as one unit for the inventory CSV.`, ...errors);
  return product;
}
