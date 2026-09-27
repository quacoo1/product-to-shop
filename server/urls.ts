import { createHash } from 'node:crypto';
import type { Retailer } from '../shared/types.js';

const domains: Record<Retailer, string[]> = {
  asos: ['asos.com'],
  boohoo: ['boohoo.com'],
  prettylittlething: ['prettylittlething.com', 'prettylittlething.us', 'prettylittlething.com.au', 'prettylittlething.fr', 'prettylittlething.ie', 'prettylittlething.ae'],
};
export const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);
export const slug = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90);
export function shortLinkRetailer(url: URL): Retailer | undefined {
  if (url.hostname === 'plt.mobi') return 'prettylittlething';
  if (url.hostname === 'bhoo.mobi') return 'boohoo';
}
export function retailerFor(url: URL): Retailer | undefined {
  return (Object.keys(domains) as Retailer[]).find(r => domains[r].some(d => url.hostname === d || url.hostname.endsWith(`.${d}`)));
}
export function productUrl(input: string): { url: string; retailer: Retailer; key: string } {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Enter a complete product URL beginning with https://.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Only standard HTTPS product links are supported.');
  const shortLink = shortLinkRetailer(url);
  const retailer = shortLink ?? retailerFor(url);
  if (!retailer) throw new Error('Use an ASOS, Boohoo, or PrettyLittleThing product link.');
  const path = url.pathname;
  const valid = shortLink ? /^\/[a-zA-Z0-9]{1,100}\/?$/.test(path) : retailer === 'asos' ? /\/prd\/\d+/i.test(path)
    : retailer === 'boohoo' ? /\/product\/[^/]+/i.test(path) || /\/[\w-]+\/[^/]+\.html$/i.test(path) || /\/[\w-]+\.html$/i.test(path)
    : /\/product\/[^/]+/i.test(path) || /\/[^/]+\.html$/i.test(path);
  if (!valid) throw new Error(shortLink ? 'Paste the complete product share link, including the code after the domain.' : 'This looks like a category or home page. Paste a product detail link.');
  url.hash = '';
  // Size selection does not change the set of sizes we extract. Color and region do.
  const keep = new Set(['colour', 'color', 'colourwayid', 'colorwayid', 'currency', 'country', 'store']);
  for (const key of [...url.searchParams.keys()]) if (!keep.has(key.toLowerCase())) url.searchParams.delete(key);
  url.searchParams.sort();
  return { url: url.href, retailer, key: `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}?${url.searchParams}` };
}
