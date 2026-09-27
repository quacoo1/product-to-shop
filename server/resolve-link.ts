import { safeFetch } from './network.js';
import { shortLinkRetailer, productUrl, retailerFor } from './urls.js';

// Resolve official share links before parsing or opening a browser. Their destination
// carries the product identity and selected color; the short token does not.
export async function resolveProductLink(input: string, signal: AbortSignal, fetcher = safeFetch): Promise<string> {
  const normalized = productUrl(input);
  const retailer = shortLinkRetailer(new URL(normalized.url));
  if (!retailer) return normalized.url;
  const name = retailer === 'boohoo' ? 'Boohoo' : 'PrettyLittleThing';
  const result = await fetcher(normalized.url, {
    signal, method: 'HEAD', timeout: 25000,
    accept: url => shortLinkRetailer(url) === retailer || retailerFor(url) === retailer,
  });
  if (shortLinkRetailer(new URL(result.url))) throw new Error(`This ${name} share link did not resolve. Copy the full product link from the retailer website.`);
  const destination = productUrl(result.url);
  if (destination.retailer !== retailer) throw new Error(`Share link left ${name}.`);
  return destination.url;
}
