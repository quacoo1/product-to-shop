import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { CloudJobs } from './jobs.js';
import { configuredStore, HttpError, RETENTION_SECONDS, type Store } from './store.js';
import { selectedProducts } from '../jobs.js';
import { toCsv, toInventoryCsv, toJson, writeZip } from '../exports.js';
import { fetchImage } from '../network.js';

interface Session { passwordVersion: string; latestBatch?: string; }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const cookieName = 'collector_session';
const info = { mode: 'cloud', browserRetry: 'upload', processing: 'request' } as const;
export interface CloudOptions { store: Store; password: string; secureCookies?: boolean; jobs?: CloudJobs; }

export function createCloudApp({ store, password, secureCookies = true, jobs = new CloudJobs(store) }: CloudOptions) {
  if (password.length < 12) throw new HttpError(503, 'Set COLLECTOR_PASSWORD to a password of at least 12 characters in Vercel and redeploy.');
  const app = express();
  const passwordVersion = digest(password);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (origin.host !== req.headers.host || (secureCookies && origin.protocol !== 'https:')) throw new Error();
      } catch { return res.status(403).json({ error: 'Cross-origin requests are not allowed.' }); }
    }
    next();
  });
  app.use(express.json({ limit: '3mb' }));
  const cookie = (token: string, maxAge = RETENTION_SECONDS) => `${cookieName}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  async function authenticate(req: express.Request) {
    const header = req.headers['x-session-token'];
    const value = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const token = typeof header === 'string' && header ? header : value;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new HttpError(401, 'Sign in to access your collection.');
    const owner = digest(token);
    const session = await store.get<Session>(`session:${owner}`);
    if (!session || session.passwordVersion !== passwordVersion) throw new HttpError(401, 'Your session expired. Sign in again.');
    return { token, owner, session };
  }
  app.get('/api/session', async (req, res) => {
    try {
      const auth = await authenticate(req);
      res.json({ ...info, token: auth.token, latestBatch: auth.session.latestBatch });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) return res.status(401).json({ ...info, error: error.message, loginRequired: true });
      throw error;
    }
  });
  app.post('/api/login', async (req, res) => {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    if (await store.count(`login:${digest(ip)}`, 300) > 10) throw new HttpError(429, 'Too many sign-in attempts. Wait five minutes and try again.');
    const provided = req.body?.password;
    if (typeof provided !== 'string' || provided.length > 1000 || !timingSafeEqual(Buffer.from(digest(provided)), Buffer.from(passwordVersion))) throw new HttpError(401, 'Incorrect access password.');
    const token = randomBytes(32).toString('hex');
    await store.put<Session>(`session:${digest(token)}`, { passwordVersion });
    res.setHeader('Set-Cookie', cookie(token));
    res.json({ ...info, token });
  });
  app.use('/api', async (req, res, next) => {
    const auth = await authenticate(req);
    // Mutations require the JS-readable token too, preventing cookie-only form submissions.
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-session-token'] !== auth.token) throw new HttpError(403, 'Refresh the page before making changes.');
    res.locals.owner = auth.owner; res.locals.token = auth.token;
    next();
  });
  app.post('/api/logout', async (_req, res) => {
    await store.remove(`session:${res.locals.owner}`);
    res.setHeader('Set-Cookie', cookie('', 0)); res.json({ ok: true });
  });
  app.post('/api/batches', async (req, res) => {
    let input: string | string[];
    if (typeof req.body?.text === 'string') input = req.body.text;
    else if (Array.isArray(req.body?.urls) && req.body.urls.every((u: unknown) => typeof u === 'string' && u.length <= 4000)) input = req.body.urls;
    else throw new HttpError(400, 'Expected product links or share text.');
    const batch = await jobs.create(res.locals.owner, input);
    await store.update<Session>(`session:${res.locals.owner}`, session => { session.latestBatch = batch.id; });
    res.status(201).json(batch);
  });
  app.get('/api/batches/:id', async (req, res) => res.json(await jobs.get(res.locals.owner, req.params.id)));
  app.post('/api/batches/:id/process', async (req, res) => res.json(await jobs.process(res.locals.owner, req.params.id)));
  app.post('/api/batches/:id/cancel', async (req, res) => res.json(await jobs.cancel(res.locals.owner, req.params.id)));
  app.post('/api/batches/:id/items/:itemId/retry', async (req, res) => res.json(await jobs.retry(res.locals.owner, req.params.id, req.params.itemId)));
  app.patch('/api/batches/:id/items/:itemId', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, 'Invalid product edits.');
    res.json(await jobs.edit(res.locals.owner, req.params.id, req.params.itemId, req.body));
  });
  app.post('/api/batches/:id/items/:itemId/html', async (req, res) => {
    const { html, sourceUrl } = req.body ?? {};
    if (typeof html !== 'string' || !html.trim() || Buffer.byteLength(html) > 2 * 1024 * 1024 || typeof sourceUrl !== 'string' || sourceUrl.length > 4000) throw new HttpError(400, 'Upload an HTML file up to 2 MB and its full product URL.');
    res.json(await jobs.process(res.locals.owner, req.params.id, { itemId: req.params.itemId, html, sourceUrl }));
  });
  app.get('/api/batches/:batchId/items/:itemId/images/:imageId', async (req, res) => {
    const batch = await jobs.get(res.locals.owner, req.params.batchId);
    const image = batch.items.find(i => i.id === req.params.itemId)?.product?.images.find(i => i.id === req.params.imageId);
    if (!image || image.validation !== 'valid') throw new HttpError(404, 'Image not found.');
    const abort = new AbortController(); res.on('close', () => abort.abort());
    const result = await fetchImage(image.url, abort.signal);
    res.type(result.headers['content-type']);
    // Use streaming, including for large image previews; never buffer a Function response.
    res.flushHeaders(); res.write(result.bytes); res.end();
  });
  app.get('/api/batches/:id/export/:format', async (req, res) => {
    const batch = await jobs.get(res.locals.owner, req.params.id);
    const format = req.params.format;
    if (!['csv', 'inventory', 'json', 'zip'].includes(format)) throw new HttpError(400, 'Choose CSV, inventory CSV, JSON, or ZIP.');
    if (!selectedProducts(batch).length && format !== 'json') throw new HttpError(400, 'Select at least one extracted product.');
    if (format === 'zip') {
      res.attachment('product-images.zip').type('application/zip');
      res.flushHeaders();
      const abort = new AbortController(); res.on('close', () => abort.abort());
      const deadline = Date.now() + 240000;
      await writeZip(batch, res, abort.signal, async (url, signal) => {
        if (Date.now() > deadline) throw new Error('The export reached its time limit. Export fewer images and retry.');
        return fetchImage(url, AbortSignal.any([signal!, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]));
      });
    } else {
      const body = format === 'json' ? JSON.stringify(toJson(batch)) : format === 'csv' ? toCsv(batch) : toInventoryCsv(batch, req.query.location);
      res.attachment(format === 'json' ? 'products.json' : format === 'csv' ? 'shopify-products.csv' : 'shopify-inventory.csv');
      res.type(format === 'json' ? 'application/json' : 'text/csv; charset=utf-8');
      res.flushHeaders(); res.write(body); res.end();
    }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  app.use((error: Error & { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) { res.destroy(); return; }
    res.status(error.status && error.status >= 400 && error.status <= 599 ? error.status : 400).json({ error: error.message || 'The request failed.' });
  });
  return app;
}

let configuredApp: ReturnType<typeof createCloudApp> | undefined;
export function getCloudApp() {
  return configuredApp ??= createCloudApp({ store: configuredStore(), password: process.env.COLLECTOR_PASSWORD || '' });
}
