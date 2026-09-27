import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jobs, selectedProducts } from './jobs.js';
import { toCsv, toInventoryCsv, toJson, writeZip } from './exports.js';
import { fetchImage } from './network.js';

const app = express();
const jobs = new Jobs();
const token = randomBytes(32).toString('hex');
const port = Number(process.env.PORT || 4317);
const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!allowedHosts.has(req.headers.host ?? '')) return res.status(403).json({ error: 'Local requests only.' });
  if (req.headers.origin && ![`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(req.headers.origin)) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: 'Cross-site requests are not allowed.' });
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self' ws://localhost:* ws://127.0.0.1:*; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  next();
});
app.use(express.json({ limit: '512kb' }));
app.get('/api/session', (_, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ token }); });
// Images are read-only and same-origin; only registered image IDs can be requested.
app.get('/api/batches/:batchId/items/:itemId/images/:imageId', async (req, res) => {
  const product = jobs.item(req.params.batchId, req.params.itemId).product;
  const image = product?.images.find(i => i.id === req.params.imageId);
  if (!image || image.validation !== 'valid') return res.status(404).end();
  const abort = new AbortController(); res.on('close', () => abort.abort());
  const result = await fetchImage(image.url, abort.signal);
  res.setHeader('Content-Type', result.headers['content-type']); res.setHeader('Cache-Control','private, max-age=600'); res.send(result.bytes);
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const provided = req.headers['x-session-token'];
  if (typeof provided !== 'string' || provided.length !== token.length || !timingSafeEqual(Buffer.from(provided), Buffer.from(token))) return res.status(403).json({ error: 'Session expired. Refresh the app.' });
  next();
});
app.post('/api/batches', (req, res) => {
  if (typeof req.body?.text === 'string') return res.status(201).json(jobs.create(req.body.text));
  const urls = req.body?.urls;
  if (!Array.isArray(urls) || urls.some(u => typeof u !== 'string' || u.length > 4000)) return res.status(400).json({ error: 'Expected a list of product links.' });
  res.status(201).json(jobs.create(urls));
});
app.get('/api/batches/:id', (req, res) => res.json(jobs.get(req.params.id).batch));
app.post('/api/batches/:id/cancel', async (req, res) => res.json(await jobs.cancel(req.params.id)));
app.post('/api/batches/:id/items/:itemId/retry', (req, res) => res.json(jobs.retry(req.params.id, req.params.itemId)));
app.patch('/api/batches/:id/items/:itemId', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'Invalid product edits.' });
  res.json(jobs.update(req.params.id, req.params.itemId, req.body));
});
app.post('/api/batches/:id/items/:itemId/browser', async (req, res) => res.json(await jobs.beginBrowser(req.params.id, req.params.itemId)));
app.post('/api/batches/:id/items/:itemId/resume', async (req, res) => res.json(await jobs.resumeBrowser(req.params.id, req.params.itemId)));
app.post('/api/batches/:id/items/:itemId/close-browser', async (req, res) => res.json(await jobs.endBrowser(req.params.id, req.params.itemId)));
app.get('/api/batches/:id/export/:format', async (req, res) => {
  const batch = jobs.get(req.params.id).batch;
  const format = req.params.format;
  if (!['csv','inventory','json','zip'].includes(format)) return res.status(400).json({ error: 'Choose product CSV, inventory CSV, JSON, or ZIP.' });
  if (!selectedProducts(batch).length && format !== 'json') return res.status(400).json({ error: 'Select at least one extracted product.' });
  if (format === 'csv') { const csv = toCsv(batch); res.attachment('shopify-products.csv').type('text/csv; charset=utf-8').send(csv); }
  else if (format === 'inventory') { const csv = toInventoryCsv(batch, req.query.location); res.attachment('shopify-inventory.csv').type('text/csv; charset=utf-8').send(csv); }
  else if (format === 'json') res.attachment('products.json').json(toJson(batch));
  else {
    res.attachment('product-images.zip').type('application/zip');
    const abort = new AbortController(); res.on('close', () => abort.abort());
    await writeZip(batch, res, abort.signal);
  }
});
app.use('/api', (_, res) => res.status(404).json({ error: 'Unknown endpoint.' }));
if (existsSync(path.join(root, 'dist/index.html'))) {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/', (_, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({ root, server: { middlewareMode: true, hmr: false }, appType: 'spa' });
  app.use(vite.middlewares);
}
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (res.headersSent) { res.destroy(); return; }
  res.status(400).json({ error: error.message || 'Something went wrong.' });
});
const server = app.listen(port, '127.0.0.1', () => console.log(`Product Collector is ready at http://localhost:${port}`));
server.on('error', error => { console.error(`Could not start: ${error.message}`); process.exitCode = 1; });
for (const event of ['SIGINT','SIGTERM'] as const) process.on(event, () => { void jobs.shutdown().finally(() => server.close(() => process.exit(0))); });
