import { load, type CheerioAPI } from 'cheerio';
import sanitize from 'sanitize-html';
import type { Availability, Product, Retailer, Variant } from '../../shared/types.js';
import { hash, slug } from '../urls.js';

export type Data = Record<string, any>;
export const str = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
export const list = (value: any): any[] => Array.isArray(value) ? value : value == null ? [] : [value];
export const cleanHtml = (value: string) => sanitize(value, { allowedTags: ['div','p','br','ul','ol','li','strong','em','b','i','h3','h4'], allowedAttributes: {} }).trim();
export const textOnly = (value: string) => load(`<div>${cleanHtml(value)}</div>`)('div').text().trim();
export function availability(value: unknown): Availability {
  if (value === true) return 'available';
  if (value === false) return 'sold_out';
  const text = str(value).toLowerCase();
  if (/outofstock|sold.?out|out.?of.?stock|discontinued/.test(text)) return 'sold_out';
  if (/instock|in.?stock|limitedavailability/.test(text)) return 'available';
  return 'unknown';
}

// Read JSON literals from known assignments without executing any retailer JavaScript.
export function assignment(html: string, name: string): any {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of html.matchAll(new RegExp(`${escaped}\\s*=\\s*`, 'g'))) {
  const start = match.index + match[0].length;
  const initial = html[start];
  try {
    if (initial === "'" || initial === '"') {
      let end = start + 1;
      for (; end < html.length; end++) { if (html[end] === '\\') end++; else if (html[end] === initial) break; }
      const literal = html.slice(start + 1, end);
      const decoded = initial === '"' ? JSON.parse(html.slice(start, end + 1)) : literal.replace(/\\'/g, "'").replace(/\\x([a-f\d]{2})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
      return JSON.parse(decoded);
    }
    if (!['{','['].includes(initial)) continue;
    let depth = 0, quoted = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (--depth === 0) return JSON.parse(html.slice(start, i + 1)); }
    }
  } catch { /* A later assignment may contain the complete JSON literal. */ }
  }
}
export function documents($: CheerioAPI): Data[] {
  const nodes: Data[] = [];
  function visit(value: any) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    nodes.push(value);
    if (value['@graph']) visit(value['@graph']);
  }
  $('script[type="application/ld+json"]').each((_, el) => { try { visit(JSON.parse($(el).text())); } catch {} });
  return nodes;
}
export function schemaProduct($: CheerioAPI): Data {
  return documents($).find(d => list(d['@type']).some(t => t === 'Product' || t === 'ProductGroup')) ?? {};
}
export function remixRoute(html: string): Data | undefined {
  const remix = assignment(html, 'window.__remixContext');
  const loaders = remix?.state?.loaderData;
  if (!loaders) return undefined;
  return Object.entries(loaders).find(([key, value]) => /\/product\//.test(key) && !!(value as Data)?.product)?.[1] as Data | undefined;
}
export function selectedColor(url: string): string {
  const query = new URL(url).searchParams;
  return query.get('colour') || query.get('color') || '';
}
export const sameColor = (a: string, b: string) => a.toLowerCase().replace(/[-_\s]+/g, '') === b.toLowerCase().replace(/[-_\s]+/g, '');
export interface Extracted {
  sourceId?: string; title?: string; description?: string; brand?: string; productType?: string;
  productCode?: string; color?: string; images?: string[]; variants?: Variant[]; warnings?: string[];
}
export function schemaVariants(schema: Data, color: string): Variant[] {
  return list(schema.hasVariant).filter(v => !color || !v.color || sameColor(str(v.color), color)).map((v, i) => ({
    id: str(v.productID || v.sku) || `variant-${i}`, size: str(v.size?.name ?? v.size) || undefined,
    color: str(v.color) || color || undefined, sku: str(v.sku) || undefined,
    availability: availability(list(v.offers)[0]?.availability),
  })).filter(v => v.size || v.color);
}
function imageUrl(value: any): string { return str(value?.url || value?.contentUrl || value); }
export function htmlImages($: CheerioAPI, selectors: string): string[] {
  const output: string[] = [];
  $(selectors).each((_, el) => {
    const node = $(el);
    const candidates = str(node.attr('srcset') || node.attr('data-srcset')).split(',').map(part => {
      const [url, width] = part.trim().split(/\s+/); return { url, width: parseFloat(width) || 0 };
    }).filter(x => x.url).sort((a,b) => b.width - a.width);
    const src = node.attr('data-zoom-image') || candidates[0]?.url || node.attr('data-src') || node.attr('src');
    if (src) output.push(src);
  });
  return output;
}
export function domVariants($: CheerioAPI, selectors: string, color: string): Variant[] {
  const variants: Variant[] = [];
  $(selectors).each((_, el) => {
    const node = $(el);
    const label = (node.attr('data-size') || node.attr('data-size-name') || node.text()).replace(/\s+/g,' ').trim();
    if (!label || /select|choose|guide/i.test(label) || label.length > 45) return;
    const soldOut = node.is('[disabled], [aria-disabled="true"], [data-available="false"]') || /sold.?out|out.of.stock/i.test(`${node.attr('aria-label')} ${node.attr('class')}`);
    variants.push({ id: hash(`${label}:${color}`), size: label.replace(/\s*[-–]?\s*(sold out|out of stock).*$/i, ''), color: color || undefined,
      sku: node.attr('data-sku'), availability: soldOut ? 'sold_out' : 'unknown' });
  });
  return variants;
}
export function finish(html: string, url: string, retailer: Retailer, data: Extracted, selectors: { description: string; gallery: string; sizes: string }): Product {
  const $ = load(html);
  const schema = schemaProduct($);
  // A category redirect or challenge must never turn recommendations into the main product.
  const title = str(schema.name) || str(data.title) || $('main h1, h1[itemprop="name"], h1[data-testid="product-title"]').first().text().trim();
  if (!title || (!schema.name && !data.sourceId && !$('[itemtype*="schema.org/Product"], [data-testid="product-details"], #product-details').length)) {
    throw new Error(/captcha|access denied|verify you|just a moment/i.test($('title').text() + $('h1').text()) ? 'This page needs browser verification.' : 'Product data was not found. The link may be unavailable or may lead to a category page.');
  }
  let color = data.color || str(schema.color) || selectedColor(url);
  const requested = selectedColor(url);
  if (requested && color && !sameColor(requested, color)) throw new Error('The page returned a different color than the link requested. Retry in browser and select the linked color.');
  const warnings = [...(data.warnings ?? [])];
  const description = cleanHtml(data.description || str(schema.description) || $(selectors.description).first().html() || '');
  let variants = data.variants?.length ? data.variants : schemaVariants(schema, color);
  if (!variants.length) variants = domVariants($, selectors.sizes, color);
  variants = [...new Map(variants.map(v => [`${v.size ?? ''}|${v.color ?? color}`, v])).values()];
  const hasSizes = variants.some(v => v.size);
  if (hasSizes) variants = variants.filter(v => v.size);
  if (!variants.length) warnings.push('Sizes could not be verified. Retry in browser before exporting to Shopify.');
  if (variants.some(v => v.availability === 'unknown')) warnings.push('Some retailer availability is unknown. Review the source page.');
  if (!description) warnings.push('Description was not available.');
  const sourceId = data.sourceId || str(schema.productID || schema.productGroupID || schema.sku) || hash(new URL(url).pathname);
  const id = hash(`${retailer}:${new URL(url).hostname.replace(/^www\./,'')}:${sourceId}:${color.toLowerCase()}`);
  const images = data.images?.length ? data.images : list(schema.image).map(imageUrl);
  const rawImages = images.length ? images : htmlImages($, selectors.gallery);
  const normalized = rawImages.map(src => { try { const u = new URL(src, url); return u.protocol === 'https:' ? u.href : ''; } catch { return ''; } }).filter(Boolean);
  const uniqueImages = [...new Set(normalized)].slice(0, 30);
  if (!uniqueImages.length) warnings.push('No product gallery images were found.');
  const brand = str(schema.brand?.name || schema.brand) || data.brand || '';
  return {
    id, handle: `${retailer}-${slug(sourceId)}${color ? `-${slug(color)}` : ''}-${id.slice(0, 6)}`, retailer, sourceUrl: url, sourceId,
    extractedAt: new Date().toISOString(), title: textOnly(title), description, brand: textOnly(brand),
    productType: textOnly(data.productType || str(schema.category)), productCode: data.productCode || str(schema.productID) || undefined,
    color: color || undefined, variants, images: uniqueImages.map((src, i) => ({ id: hash(src), url: src, alt: `${textOnly(title)} — image ${i + 1}`, included: true, validation: 'invalid', error: 'Not yet validated.' })),
    warnings, included: true,
  };
}
