import { parseProduct } from './adapters/index.js';
import { browserHtml } from './browser.js';
import { fetchImage, safeFetch } from './network.js';
import { productUrl, retailerFor } from './urls.js';
import type { Product, Retailer } from '../shared/types.js';
import { resolveProductLink } from './resolve-link.js';
import { withRequestedColor } from './selection.js';

export async function validateImages(product: Product, signal: AbortSignal) {
  for (let i = 0; i < product.images.length; i += 2) {
    signal.throwIfAborted();
    await Promise.all(product.images.slice(i, i + 2).map(async image => {
      try { await fetchImage(image.url, signal); image.validation = 'valid'; delete image.error; }
      catch (error) { signal.throwIfAborted(); image.validation = 'invalid'; image.error = error instanceof Error ? error.message : 'Image request failed.'; }
    }));
  }
  if (product.images.some(i => i.validation === 'invalid')) product.warnings.push('Some images are not publicly downloadable and will be omitted from the Shopify CSV.');
  return product;
}
export async function extract(url: string, retailer: Retailer, signal: AbortSignal, color?: string): Promise<Product> {
  url = withRequestedColor(await resolveProductLink(url, signal), color);
  let parsed: Product | undefined;
  let lastError: unknown;
  try {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      result = await safeFetch(url, { signal, accept: u => retailerFor(u) === retailer });
      if (result.status < 500 && result.status !== 429) break;
      if (!attempt) await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('Cancelled.')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
        signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (!result || result.status !== 200) throw new Error(`Retailer returned HTTP ${result?.status ?? 'error'}.`);
    productUrl(result.url); // Reject category redirects even if they contain product cards.
    parsed = parseProduct(result.bytes.toString('utf8'), url, retailer);
    if (parsed.variants.length) return await validateImages(parsed, signal);
  } catch (error) { signal.throwIfAborted(); lastError = error; }
  try {
    const html = await browserHtml(url, retailer, signal);
    const rendered = parseProduct(html, url, retailer);
    if (!parsed || rendered.variants.length) parsed = rendered;
  } catch (error) { signal.throwIfAborted(); lastError = error; }
  if (parsed) {
    if (!parsed.variants.length) parsed.warnings.push('Shopify CSV export is disabled for this product until sizes can be verified. JSON remains available.');
    return validateImages(parsed, signal);
  }
  throw new Error(`${lastError instanceof Error ? lastError.message : 'Extraction failed.'} Try opening this link in the browser.`);
}
