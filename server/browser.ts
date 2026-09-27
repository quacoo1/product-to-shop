import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { safeFetch, MAX_HTML } from './network.js';
import { retailerFor, productUrl } from './urls.js';
import type { Retailer } from '../shared/types.js';
import { resolveProductLink } from './resolve-link.js';
import { withRequestedColor } from './selection.js';

export interface BrowserSession { browser: Browser; context: BrowserContext; page: Page; entryUrl: string; close: () => Promise<void> }
export async function openProductBrowser(url: string, headed: boolean, signal: AbortSignal, color?: string): Promise<BrowserSession> {
  url = withRequestedColor(await resolveProductLink(url, signal), color);
  let browser: Browser;
  const edge = process.platform === 'win32' && ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].some(existsSync);
  try {
    if (process.env.VERCEL) {
      if (headed) throw new Error('Use saved HTML upload for browser retry on Vercel.');
      const { default: serverlessChromium } = await import('@sparticuz/chromium');
      browser = await chromium.launch({ headless: true, executablePath: await serverlessChromium.executablePath(), args: serverlessChromium.args });
    } else browser = await chromium.launch({ headless: !headed, ...(edge ? { channel: 'msedge' } : {}) });
  }
  catch { throw new Error(process.env.VERCEL ? 'Cloud browser could not start. Retry automatically or upload the saved product page.' : 'Browser could not start. Close stale browser windows or run npm run browser:install, then retry.'); }
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const retailer = productUrl(url).retailer;
  // Every browser request goes through the same DNS-pinned public-only transport.
  // This also constrains page scripts, redirects, frames, and image requests.
  await context.route('**/*', async route => {
    const req = route.request();
    try {
      if (!['GET','POST','HEAD'].includes(req.method()) || !req.url().startsWith('https://')) return await route.abort();
      if (req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame() && retailerFor(new URL(req.url())) !== retailer) return await route.abort();
      const headers = await req.allHeaders();
      for (const name of ['host','connection','content-length','accept-encoding']) delete headers[name];
      const result = await safeFetch(req.url(), { signal, headers, method: req.method(), body: req.postDataBuffer() ?? undefined, maxBytes: MAX_HTML,
        accept: req.isNavigationRequest() && req.frame() === req.frame().page().mainFrame() ? u => retailerFor(u) === retailer : undefined });
      const responseHeaders = { ...result.headers };
      for (const name of ['content-encoding','content-length','transfer-encoding','connection']) delete responseHeaders[name];
      await route.fulfill({ status: result.status, headers: responseHeaders, body: result.bytes });
    } catch { await route.abort().catch(() => {}); }
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  const page = await context.newPage();
  const abort = () => { void browser.close().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const close = async () => { signal.removeEventListener('abort', abort); await browser.close().catch(() => {}); };
  try {
    signal.throwIfAborted();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (retailerFor(new URL(page.url())) !== retailer) throw new Error('Browser left the supported retailer.');
    if (!headed) await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    return { browser, context, page, entryUrl: page.url(), close };
  } catch (error) { await close(); throw error; }
}
export async function browserHtml(url: string, retailer: Retailer, signal: AbortSignal) {
  const session = await openProductBrowser(url, false, signal);
  try {
    const final = productUrl(session.page.url());
    if (final.retailer !== retailer) throw new Error('Browser left the retailer.');
    return await session.page.content();
  } finally { await session.close(); }
}
