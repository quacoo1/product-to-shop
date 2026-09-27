import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { CloudJobs, type SavedBatch } from '../server/cloud/jobs.js';
import { createCloudApp } from '../server/cloud/app.js';
import { createHandler } from '../api/handler.js';
import { configuredStore } from '../server/cloud/store.js';
import { MemoryStore } from './support/memory-store.js';
import { parseProduct } from '../server/adapters/index.js';
import { toCsv, toInventoryCsv } from '../server/exports.js';
import { withRequestedColor } from '../server/selection.js';
import type { Batch, Product } from '../shared/types.js';

const source = 'https://www.boohoo.com/product/boohoo-contrast-lace-cut-out-mini-dress_gzz26440';
const html = readFileSync(new URL('./fixtures/boohoo.html', import.meta.url), 'utf8');
const extractFixture = async (_url: string, _retailer: unknown, _signal: AbortSignal, color?: string) => parseProduct(html, withRequestedColor(source, color), 'boohoo');
const validate = async (p: Product) => p;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('Cloud batches persist across app instances with selections, edits and exports', async () => {
  const store = new MemoryStore();
  const first = new CloudJobs(store, extractFixture, validate);
  const second = new CloudJobs(store, extractFixture, validate);
  const b = await first.create('owner', `${source}\nBlack 2(UK 12,12)`);
  assert.equal(b.items[0].status, 'queued');
  await second.process('owner', b.id);
  const loaded = await first.get('owner', b.id);
  assert.equal(loaded.running, false);
  assert.equal(loaded.items[0].product!.variants.length, 1);
  assert.equal(loaded.items[0].product!.variants[0].requestedQuantity, 2);
  await first.edit('owner', b.id, b.items[0].id, { title: 'Edited across instances' });
  const edited = await second.get('owner', b.id);
  assert.match(toCsv(edited), /Edited across instances/);
  assert.match(toInventoryCsv(edited, 'Warehouse'), /,not stocked,2\n/);
  await assert.rejects(second.get('another-owner', b.id), /not found/i);
});

test('Concurrent function instances claim a product only once and preserve cancellation', async () => {
  const store = new MemoryStore(); const started = deferred<void>(); const release = deferred<void>(); let calls = 0;
  const extract = async (...args: Parameters<typeof extractFixture>) => { calls++; started.resolve(); await release.promise; return extractFixture(...args); };
  const first = new CloudJobs(store, extract, validate); const second = new CloudJobs(store, extract, validate);
  const b = await first.create('owner', [source]);
  const pending = first.process('owner', b.id); await started.promise;
  const concurrent = await second.process('owner', b.id);
  assert.equal(concurrent.items[0].status, 'extracting'); assert.equal(calls, 1);
  await second.cancel('owner', b.id); release.resolve(); await pending;
  const cancelled = await first.get('owner', b.id);
  assert.equal(cancelled.items[0].status, 'cancelled'); assert.equal(cancelled.items[0].product, undefined);
  await second.retry('owner', b.id, b.items[0].id); await first.process('owner', b.id);
  assert.equal((await second.get('owner', b.id)).items[0].status, 'success');
});

test('Expired worker leases resume queued work after an interrupted function', async () => {
  let now = Date.now(); const store = new MemoryStore(() => now);
  const jobs = new CloudJobs(store, extractFixture, validate, undefined, () => now);
  const b = await jobs.create('owner', [source]);
  await store.update<SavedBatch>(`batch:owner:${b.id}`, saved => {
    saved.batch.items[0].status = 'extracting'; saved.attempts[b.items[0].id] = 1;
    saved.leases[b.items[0].id] = { token: 'dead-worker', until: now + 1000 };
  });
  now += 1001;
  const resumed = await jobs.process('owner', b.id);
  assert.equal(resumed.items[0].status, 'success'); assert.equal(resumed.running, false);
});

test('A saved HTML page replaces desktop browser retry and verifies product identity', async () => {
  const jobs = new CloudJobs(new MemoryStore(), async () => { throw new Error('Retailer blocked request'); }, validate);
  const b = await jobs.create('owner', `${source}\nHot pink 2(UK 12,12)`);
  await jobs.process('owner', b.id);
  const wrong = await jobs.process('owner', b.id, { itemId: b.items[0].id, html, sourceUrl: source.replace('gzz26440', 'other') });
  assert.equal(wrong.items[0].status, 'needs_browser'); assert.match(wrong.items[0].error!, /same product/);
  const good = await jobs.process('owner', b.id, { itemId: b.items[0].id, html, sourceUrl: source });
  assert.equal(good.items[0].status, 'success');
  assert.equal(good.items[0].product!.color, 'Hot Pink');
  assert.equal(good.items[0].product!.variants[0].requestedQuantity, 2);
});

test('Vercel API supports sign-in, persistent sessions, batches, processing and exports across instances', async t => {
  const store = new MemoryStore();
  const options = { store, password: 'test-password-only', secureCookies: false, jobs: new CloudJobs(store, extractFixture, validate) };
  const apps = [createCloudApp(options), createCloudApp(options)];
  const servers = apps.map(app => app.listen(0, '127.0.0.1'));
  t.after(() => { for (const server of servers) server.close(); });
  await Promise.all(servers.map(server => once(server, 'listening')));
  const bases = servers.map(server => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  assert.equal((await fetch(`${bases[0]}/api/session`)).status, 401);
  assert.equal((await fetch(`${bases[0]}/api/session`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const login = await fetch(`${bases[0]}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: options.password }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
  const { token } = await login.json() as { token: string };
  const headers = { 'X-Session-Token': token, 'Content-Type': 'application/json' };
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(`${bases[1]}/api/session`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${bases[1]}/api/batches`, { method: 'POST', headers: { Cookie: cookie } })).status, 403);
  const created = await fetch(`${bases[0]}/api/batches`, { method: 'POST', headers, body: JSON.stringify({ text: `${source}\n2(UK 12,12)` }) });
  assert.equal(created.status, 201); const b = await created.json() as Batch;
  const processed = await fetch(`${bases[1]}/api/batches/${b.id}/process`, { method: 'POST', headers });
  assert.equal(processed.status, 200); assert.equal((await processed.json() as Batch).items[0].status, 'success');
  assert.equal((await fetch(`${bases[1]}/api/session`, { headers }).then(r => r.json()) as { latestBatch: string }).latestBatch, b.id);
  assert.equal((await fetch(`${bases[0]}/api/batches/${b.id}`)).status, 401);
  const inventory = await fetch(`${bases[0]}/api/batches/${b.id}/export/inventory?location=Warehouse`, { headers });
  assert.equal(inventory.status, 200); assert.match(await inventory.text(), /,not stocked,2\n/);
  assert.equal((await fetch(`${bases[0]}/api/logout`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(`${bases[1]}/api/session`, { headers })).status, 401);
});

test('The Vercel rewrite forwards API paths and query strings to Express', async t => {
  const target = express(); target.get('/api/batches/test/export/inventory', (req, res) => res.json({ location: req.query.location }));
  const host = express(); host.use(createHandler(() => target));
  const server = host.listen(0, '127.0.0.1'); t.after(() => server.close()); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const response = await fetch(`${base}/api/handler?__route=batches/test/export/inventory&location=Warehouse`);
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { location: 'Warehouse' });
});

test('Missing Redis credentials and a missing password fail with actionable setup errors', () => {
  assert.throws(() => configuredStore({}), /Connect Upstash Redis/);
  assert.throws(() => createCloudApp({ store: new MemoryStore(), password: '' }), /COLLECTOR_PASSWORD/);
});
