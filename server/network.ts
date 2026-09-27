import dns from 'node:dns/promises';
import { Agent, fetch as request } from 'undici';
import ipaddr from 'ipaddr.js';

export const MAX_HTML = 12 * 1024 * 1024;
export const MAX_IMAGE = 15 * 1024 * 1024;
export function publicIp(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    return ip.range() === 'unicast';
  } catch { return false; }
}
export async function publicTarget(input: string): Promise<URL> {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Only public HTTPS URLs are allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Local network addresses are not allowed.');
  const addresses = await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(a => !publicIp(a.address))) throw new Error('Private or reserved network addresses are not allowed.');
  return url;
}

// Resolve again inside the actual connection and reject every non-public address.
// This prevents a DNS change between URL validation and connection from reaching localhost.
const dispatcher = new Agent({ connect: { lookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }).then(addresses => {
    if (!addresses.length || addresses.some(a => !publicIp(a.address))) return callback(new Error('Non-public address rejected'), '', 4);
    if ((options as { all?: boolean }).all) (callback as Function)(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  }).catch(error => callback(error, '', 4));
} } });

export interface FetchResult { bytes: Buffer; url: string; status: number; headers: Record<string, string> }
export async function safeFetch(input: string, opts: {
  signal?: AbortSignal; maxBytes?: number; timeout?: number; headers?: Record<string, string>;
  method?: string; body?: Buffer; accept?: (url: URL) => boolean;
} = {}): Promise<FetchResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeout ?? 25000), ...(opts.signal ? [opts.signal] : [])]);
  let current = input;
  let headers = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36', ...opts.headers };
  let method = opts.method ?? 'GET';
  let body = opts.body;
  for (let redirect = 0; redirect < 6; redirect++) {
    signal.throwIfAborted();
    const url = await publicTarget(current);
    if (opts.accept && !opts.accept(url)) throw new Error('Redirect left the supported retailer.');
    const response = await request(url, { dispatcher, redirect: 'manual', signal, headers, method, body });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.get('location')) {
      const next = new URL(response.headers.get('location')!, url);
      await response.body?.cancel();
      if (next.origin !== url.origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([key]) => !['cookie', 'authorization'].includes(key.toLowerCase()))) as typeof headers;
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
      current = next.href;
      continue;
    }
    const maxBytes = opts.maxBytes ?? MAX_HTML;
    if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new Error('Response exceeds the download size limit.'); }
    const chunks: Buffer[] = [];
    let size = 0;
    if (response.body) for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) { await response.body.cancel().catch(() => {}); throw new Error('Response exceeds the download size limit.'); }
      chunks.push(Buffer.from(chunk));
    }
    return { bytes: Buffer.concat(chunks), status: response.status, url: current, headers: Object.fromEntries(response.headers.entries()) };
  }
  throw new Error('Too many redirects.');
}
export function imageKind(bytes: Buffer): 'jpg' | 'png' | 'gif' | 'webp' | 'avif' | undefined {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (bytes.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 32).toString())) return 'avif';
}
export async function fetchImage(url: string, signal?: AbortSignal) {
  const result = await safeFetch(url, { signal, maxBytes: MAX_IMAGE, timeout: 18000 });
  const extension = imageKind(result.bytes);
  if (result.status !== 200 || !extension || !result.headers['content-type']?.startsWith('image/')) throw new Error(`Image is not publicly downloadable (HTTP ${result.status}).`);
  return { ...result, extension };
}
