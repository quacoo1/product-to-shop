import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProductInput } from '../shared/input.js';
import { applySelection, withRequestedColor } from '../server/selection.js';
import { parseProduct } from '../server/adapters/index.js';
import { Jobs } from '../server/jobs.js';
import { toCsv, toInventoryCsv, toJson } from '../server/exports.js';

const example = `Check out this item I found on Boohoo https://bhoo.mobi/1kTIdwusa1
2(Uk 10 12)
Check out this item I found on Boohoo https://bhoo.mobi/0y8GIXPVnE
Burnt orange 3(uk 10,12,)
Taupe 3(uk 10,12,14 16)
Check out this item I found on Boohoo https://bhoo.mobi/HFHTYhLQyT
7
White (uk 14,16,18)
Cream floral ( uk 10,12)
Brown uk (16,16)`;
const url = 'https://www.boohoo.com/product/boohoo-dress_gzz26440';
const fixture = readFileSync(new URL('./fixtures/boohoo.html', import.meta.url), 'utf8');
const product = (color?: string) => parseProduct(fixture, withRequestedColor(url, color), 'boohoo');
async function settle(jobs: Jobs, id: string) {
  for (let n = 0; n < 100; n++) {
    if (!jobs.get(id).batch.running) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Batch did not settle.');
}

test('All supplied share formats retain colour, repeated sizes and original count notes', () => {
  const entries = parseProductInput(example);
  assert.equal(entries.length, 6);
  assert.deepEqual(entries.map(e => e.selection?.color), [undefined, 'Burnt orange', 'Taupe', 'White', 'Cream floral', 'Brown']);
  assert.deepEqual(entries.map(e => e.selection?.sizes), [
    ['UK 10', 'UK 12'], ['UK 10', 'UK 12'], ['UK 10', 'UK 12', 'UK 14', 'UK 16'],
    ['UK 14', 'UK 16', 'UK 18'], ['UK 10', 'UK 12'], ['UK 16', 'UK 16'],
  ]);
  assert.deepEqual(entries[5].selection?.notes, ['7', 'Brown uk (16,16)']);
  assert.equal(entries[0].url, 'https://bhoo.mobi/1kTIdwusa1');
  assert.deepEqual(parseProductInput(example.replaceAll('\n', '\r\n')), entries);
});

test('Plain URLs, share messages without notes, inline notes and malformed notes', () => {
  assert.deepEqual(parseProductInput(`Check out this item I found on Boohoo ${url}\n${url}`), [{ url }, { url }]);
  assert.deepEqual(parseProductInput(`${url} 2(Uk 10 12)`)[0].selection?.sizes, ['UK 10', 'UK 12']);
  for (const note of ['White (UK 10/12)', 'White (UK 10-16)', 'White (UK 10,abc)', 'White (UK)', '3', '10,12']) {
    assert.throws(() => parseProductInput(`${url}\n${note}`));
  }
  assert.throws(() => parseProductInput(Array(51).fill(url).join('\n')), /50/);
});

test('Requested colour overrides resolved link colour and preserves region', () => {
  const requested = new URL(withRequestedColor(`${url}?color=black&country=GB&colourwayid=123`, 'Hot Pink'));
  assert.equal(requested.searchParams.get('colour'), 'Hot Pink');
  assert.equal(requested.searchParams.get('country'), 'GB');
  assert.equal(requested.searchParams.has('color'), false);
  assert.equal(requested.searchParams.has('colourwayid'), false);
});

test('Selection filters verified sizes without duplicating variants or changing availability', () => {
  const p = applySelection(product('Hot Pink'), { color: 'Hot pink', sizes: ['UK 10', 'UK 12', 'UK 12'], notes: ['Hot pink (UK 10,12,12)'] });
  assert.equal(p.variants.length, 2);
  assert.deepEqual(p.selectionErrors, []);
  assert.equal(new Set(p.variants.map(v => v.id)).size, 2);
  assert.ok(p.variants.every(v => v.color === 'Hot Pink'));
});

test('Unverified requested sizes block both CSV exports while JSON retains the request', async () => {
  const jobs = new Jobs(async () => product());
  const b = jobs.create(`${url}\n(UK 10,99)`); await settle(jobs, b.id);
  assert.equal(b.items[0].product!.variants.length, 1);
  assert.match(b.items[0].product!.selectionErrors!.join(' '), /UK 99/);
  assert.throws(() => toCsv(b), /Verify sizes/);
  assert.throws(() => toInventoryCsv(b, 'Warehouse'), /Verify sizes/);
  assert.deepEqual(toJson(b).products[0].requestedSelection?.sizes, ['UK 10', 'UK 99']);
});

test('UK requests never match explicitly US-labelled sizes or bare sizes on a US storefront', () => {
  for (const [sourceUrl, size] of [[url, 'US 10'], [`${url}?country=US`, '10']]) {
    const p = product(); p.sourceUrl = sourceUrl; p.variants = [{ id: 'test', size, availability: 'unknown' }];
    applySelection(p, { sizes: ['UK 10'], notes: ['(UK 10)'] });
    assert.equal(p.variants.length, 0); assert.equal(p.selectionErrors?.length, 1);
  }
});

test('Colour groups survive extraction, exports and retry; overlapping requests combine sizes', async () => {
  const colors: (string | undefined)[] = [];
  const jobs = new Jobs(async (_url, _retailer, _signal, color) => { colors.push(color); return product(color); });
  const b = jobs.create(`${url}\nBlack (UK 10)\nHot pink (UK 12,12)\n${url}\nBlack (UK 14)`);
  await settle(jobs, b.id);
  assert.equal(b.items.length, 2); assert.equal(b.duplicates, 1);
  assert.deepEqual(colors, ['Black', 'Hot pink']);
  assert.equal(b.items[0].product!.variants.length, 2); assert.equal(b.items[1].product!.variants.length, 1);
  assert.equal(toInventoryCsv(b, 'Warehouse').trim().split('\n').length, 4);
  assert.deepEqual(toInventoryCsv(b, 'Warehouse').trim().split('\n').slice(1).map(row => row.split(',').at(-1)), ['1', '1', '2']);
  jobs.retry(b.id, b.items[0].id); await settle(jobs, b.id);
  assert.equal(b.items[0].product!.variants.length, 2);
});

test('Expected quantities validate against every size occurrence, including a whole-product total', async () => {
  const entries = parseProductInput(example);
  assert.deepEqual(entries[0].selection?.quantityChecks, [{ scope: 'colour', expected: 2, actual: 2 }]);
  assert.deepEqual(entries[1].selection?.quantityChecks, [{ scope: 'colour', expected: 3, actual: 2 }]);
  assert.deepEqual(entries[2].selection?.quantityChecks, [{ scope: 'colour', expected: 3, actual: 4 }]);
  assert.deepEqual(entries[5].selection?.quantityChecks, [{ scope: 'product', expected: 7, actual: 7 }]);
  const jobs = new Jobs(async () => product());
  const bad = jobs.create(`${url}\n3(12,12)`); await settle(jobs, bad.id);
  assert.equal(bad.items[0].product!.variants[0].requestedQuantity, 2);
  assert.match(bad.items[0].product!.selectionErrors!.join(' '), /expected 3, but sizes list 2/);
  assert.throws(() => toCsv(bad), /quantities/);
  assert.throws(() => toInventoryCsv(bad, 'Warehouse'), /quantities/);
  const good = jobs.create(`${url}\n2(12,12)`); await settle(jobs, good.id);
  assert.deepEqual(good.items[0].product!.selectionErrors, []);
  assert.match(toInventoryCsv(good, 'Warehouse'), /,not stocked,2\n/);
  const mismatch = jobs.create(`${url}\n4\nBlack (UK 10,12)`); await settle(jobs, mismatch.id);
  assert.match(mismatch.items[0].product!.selectionErrors!.join(' '), /whole product.*expected 4.*2 units/);
});

test('Browser retry preserves colour and requested sizes from share notes', async () => {
  let receivedColor: string | undefined;
  const destination = withRequestedColor(url, 'Black');
  const jobs = new Jobs(async () => { throw new Error('Blocked'); }, async (_url, _headed, _signal, color) => {
    receivedColor = color;
    return { browser: { on() {} }, page: { url: () => destination, content: async () => fixture }, entryUrl: destination, close: async () => {} } as any;
  }, async p => p);
  const b = jobs.create('https://bhoo.mobi/test123\nHot pink (UK 12,12)'); await settle(jobs, b.id);
  await jobs.beginBrowser(b.id, b.items[0].id); await jobs.resumeBrowser(b.id, b.items[0].id);
  assert.equal(receivedColor, 'Hot pink');
  assert.equal(b.items[0].product!.color, 'Hot Pink');
  assert.equal(b.items[0].product!.variants.length, 1);
});
