import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProduct } from '../server/adapters/index.js';
import { cleanHtml, assignment } from '../server/adapters/common.js';
import { productUrl } from '../server/urls.js';
import { publicIp, imageKind } from '../server/network.js';
import { toCsv, toInventoryCsv, INVENTORY_HEADERS, toJson, CSV_HEADERS, writeZip } from '../server/exports.js';
import { PassThrough } from 'node:stream';
import { finished as streamFinished } from 'node:stream/promises';
import { inflateRawSync } from 'node:zlib';
import { Jobs } from '../server/jobs.js';
import { resolveProductLink } from '../server/resolve-link.js';
import type { Batch, Product, Retailer } from '../shared/types.js';

const urls = {
  asos: 'https://www.asos.com/asos-design/dress/prd/209696517',
  boohoo: 'https://www.boohoo.com/product/boohoo-contrast-lace-cut-out-mini-dress_gzz26440',
  prettylittlething: 'https://www.prettylittlething.com/product/prettylittlething-prettylittlething-beauty-advent-calendar-2026---worth-297_ydd23636?colour=multi',
};
const fixture = (retailer: Retailer) => readFileSync(new URL(`./fixtures/${retailer}.html`, import.meta.url), 'utf8');
const product = (retailer: Retailer = 'asos') => parseProduct(fixture(retailer), urls[retailer], retailer);
function batch(p: Product): Batch { return { id:'batch', createdAt:'2026-09-18T00:00:00Z', items:[{id:'item',url:p.sourceUrl,retailer:p.retailer,status:'success',product:p}],duplicates:0,cancelled:false,running:false }; }
const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function finished(jobs: Jobs, id: string) { for(let i=0;i<100;i++){if(!jobs.get(id).batch.running)return;await pause();}throw new Error('Queue did not settle'); }

test('ASOS preserves the complete Product Details section, bullets, care, material, code and brand text', () => {
  const p = product();
  assert.equal(p.variants.length, 8); assert.equal(p.images.length, 4);
  assert.deepEqual(p.variants.map(v=>v.size), ['UK 4','UK 6','UK 8','UK 10','UK 12','UK 14','UK 16','UK 18']);
  assert.match(p.description, /<ul><li>Plain design/);
  assert.match(p.description, /Product Code: 152551850/);
  assert.match(p.description, /Machine wash/); assert.match(p.description, /95% Cotton, 5% Elastane/);
  assert.match(p.description, /Created by us, styled by you/);
  assert.doesNotMatch(p.description, /Model's height/);
  assert.ok(p.variants.every(v=>v.sku && v.color==='Black'));
});
test('Boohoo exports the linked color and every size, including sold-out sizes', () => {
  const black = product('boohoo');
  assert.equal(black.variants.length, 6); assert.equal(black.images.length, 4);
  assert.ok(black.variants.every(v=>v.color==='Black' && v.availability==='sold_out'));
  const pink = parseProduct(fixture('boohoo'), `${urls.boohoo}?colour=hot%20pink`, 'boohoo');
  assert.ok(pink.variants.every(v=>v.color==='Hot Pink'));
  assert.notEqual(black.handle,pink.handle);
  assert.ok(pink.images.every(i=>/pink/i.test(i.url)));
  assert.match(black.description,/95% Polyester 5% Elastane/);
});
test('PrettyLittleThing adapter reads current product data and listed size', () => {
  const p = product('prettylittlething');
  assert.equal(p.retailer,'prettylittlething'); assert.ok(p.variants.length > 0); assert.ok(p.images.length > 0);
  assert.equal(p.color,'Multi'); assert.ok(p.description.length > 100);
});
test('Malformed schema is skipped; embedded product data still works', () => {
  const html = fixture('asos').replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '<script type="application/ld+json">{bad}</script>');
  const p = parseProduct(html, urls.asos, 'asos'); assert.equal(p.variants.length,8); assert.match(p.title,/ASOS DESIGN/);
});
test('Missing variants are not invented; duplicate gallery URLs are removed', () => {
  const html = '<script type="application/ld+json">{"@type":"Product","name":"Test dress","image":["https://example.com/a.jpg","https://example.com/a.jpg"]}</script>';
  const p = parseProduct(html,urls.boohoo,'boohoo');
  assert.equal(p.variants.length,0); assert.equal(p.images.length,1); assert.ok(p.warnings.some(w=>w.includes('Sizes')));
  assert.throws(()=>toCsv(batch(p)),/Verify sizes/);
});
test('Category, challenge and unsupported links fail clearly', () => {
  assert.throws(()=>parseProduct('<h1>Dresses</h1>',urls.boohoo,'boohoo'),/Product data was not found/);
  assert.throws(()=>parseProduct('<title>Just a moment</title><h1>Verify you are human</h1>',urls.asos,'asos'),/browser verification/);
  for(const url of ['http://www.asos.com/a/prd/1','https://evil.com/a','https://asos.com.evil.com/a/prd/1','https://www.boohoo.com/categories/dresses','https://user:pass@www.asos.com/a/prd/1'])assert.throws(()=>productUrl(url));
});
test('Tracking and selected size deduplicate while color and region are preserved', () => {
  assert.equal(productUrl(`${urls.boohoo}?size=8&utm_source=test`).key,productUrl(urls.boohoo).key);
  assert.notEqual(productUrl(`${urls.boohoo}?colour=black`).key,productUrl(`${urls.boohoo}?colour=pink`).key);
  assert.equal(productUrl('https://www.prettylittlething.com/black-dress.html').retailer,'prettylittlething');
});

test('Official PLT share links are accepted without accepting lookalike domains or arbitrary paths', () => {
  const link = productUrl('https://plt.mobi/jiTbyRQBDD?utm_source=share');
  assert.equal(link.retailer, 'prettylittlething');
  assert.equal(link.url, 'https://plt.mobi/jiTbyRQBDD');
  for (const input of ['https://plt.mobi/', 'https://plt.mobi/a/b', 'https://evil.plt.mobi/abc', 'https://plt.mobi.evil.com/abc', 'http://plt.mobi/abc', 'https://user@plt.mobi/abc']) assert.throws(() => productUrl(input));
});

test('PLT share resolution preserves destination color/region and constrains every redirect', async () => {
  const resolved = await resolveProductLink('https://plt.mobi/jiTbyRQBDD', new AbortController().signal, async (input, options) => {
    assert.equal(input, 'https://plt.mobi/jiTbyRQBDD');
    assert.equal(options?.method, 'HEAD'); assert.ok(options?.signal); assert.equal(options?.timeout, 25000);
    assert.equal(options!.accept!(new URL('https://plt.mobi/next')), true);
    assert.equal(options!.accept!(new URL(urls.prettylittlething)), true);
    for (const url of ['https://example.com/', urls.asos, 'https://127.0.0.1/', 'https://plt.mobi.evil.com/']) assert.equal(options!.accept!(new URL(url)), false);
    return { bytes: Buffer.alloc(0), status: 200, headers: {}, url: 'https://www.prettylittlething.com/product/one-shoulder-dress_gzz83245?utm_source=share&colour=bright+green&country=GB' };
  });
  assert.equal(resolved, 'https://www.prettylittlething.com/product/one-shoulder-dress_gzz83245?colour=bright+green&country=GB');
  assert.equal(await resolveProductLink(urls.asos, new AbortController().signal, async () => { throw new Error('Should not fetch a full product URL'); }), urls.asos);
});

test('Unresolved, external and category share destinations fail without becoming products', async () => {
  for (const destination of ['https://plt.mobi/jiTbyRQBDD', 'https://www.prettylittlething.com/', urls.asos, 'https://127.0.0.1/a.html']) {
    await assert.rejects(resolveProductLink('https://plt.mobi/jiTbyRQBDD', new AbortController().signal, async () => ({ bytes: Buffer.alloc(0), status: 200, headers: {}, url: destination })));
  }
});

for (const [domain, shop] of [['plt.mobi', 'prettylittlething.com'], ['bhoo.mobi', 'boohoo.com']]) {
test(`Browser retry for ${domain} parses the resolved product color`, async () => {
  const destination = `https://www.${shop}/product/boohoo-dress_gzz26440?colour=hot+pink`;
  const jobs = new Jobs(async () => { throw new Error('Blocked'); }, async () => ({ browser: { on() {} }, context: {}, page: { url: () => destination, content: async () => fixture('boohoo') }, entryUrl: destination, close: async () => {} }) as any, async p => p);
  const b = jobs.create([`https://${domain}/example123`]); await finished(jobs, b.id);
  await jobs.beginBrowser(b.id, b.items[0].id); await jobs.resumeBrowser(b.id, b.items[0].id);
  assert.equal(b.items[0].status, 'success');
  assert.equal(b.items[0].product!.color, 'Hot Pink');
  assert.equal(b.items[0].product!.sourceUrl, destination);
});
}

test('Boohoo short links require a share code and reject lookalike hosts and unsafe URLs', () => {
  assert.deepEqual(productUrl('https://bhoo.mobi/example123?utm_source=share'), {
    url: 'https://bhoo.mobi/example123', retailer: 'boohoo', key: 'bhoo.mobi/example123?',
  });
  assert.throws(() => productUrl('https://bhoo.mobi/'), /including the code/);
  for (const input of ['https://bhoo.mobi/a/b', 'https://evil.bhoo.mobi/abc', 'https://bhoo.mobi.evil.com/abc', 'http://bhoo.mobi/abc', 'https://user@bhoo.mobi/abc', 'https://bhoo.mobi:444/abc']) assert.throws(() => productUrl(input));
});

test('Boohoo share links preserve color and region and stay within Boohoo', async () => {
  const resolved = await resolveProductLink('https://bhoo.mobi/example123', new AbortController().signal, async (_input, options) => {
    assert.equal(options!.accept!(new URL('https://bhoo.mobi/another')), true);
    assert.equal(options!.accept!(new URL(urls.boohoo)), true);
    for (const url of ['https://plt.mobi/abc', urls.prettylittlething, urls.asos, 'https://127.0.0.1/', 'https://bhoo.mobi.evil.com/']) assert.equal(options!.accept!(new URL(url)), false);
    return { bytes: Buffer.alloc(0), status: 200, headers: {}, url: `${urls.boohoo}?colour=hot+pink&country=GB&utm_source=share` };
  });
  assert.equal(resolved, `${urls.boohoo}?colour=hot+pink&country=GB`);
  for (const destination of ['https://bhoo.mobi/example123', 'https://www.boohoo.com/', urls.prettylittlething, 'https://plt.mobi/abc']) {
    await assert.rejects(resolveProductLink('https://bhoo.mobi/example123', new AbortController().signal, async () => ({ bytes: Buffer.alloc(0), status: 200, headers: {}, url: destination })));
  }
});
test('Public network filter rejects local, mapped, link-local and reserved IPs', () => {
  for(const address of ['127.0.0.1','10.0.0.1','192.168.1.5','169.254.169.254','0.0.0.0','::1','fc00::1','::ffff:127.0.0.1','100.64.0.1','224.1.1.1'])assert.equal(publicIp(address),false,address);
  assert.equal(publicIp('1.1.1.1'),true); assert.equal(publicIp('2606:4700:4700::1111'),true);
});
test('Sanitization preserves product formatting and rejects scripts, event handlers and spreadsheet formulas', () => {
  assert.equal(cleanHtml('<p onclick="evil()">Hello <strong>world</strong><script>evil()</script></p>'),'<p>Hello <strong>world</strong></p>');
  const p=product();p.title='=HYPERLINK("evil")';assert.match(toCsv(batch(p)),/'=HYPERLINK/);
  assert.equal(assignment('window.example = {"text":"a } bracket", "nested":{"x":1}};', 'window.example').nested.x,1);
  assert.equal(assignment('window.example = evil();','window.example'),undefined);
});
test('CSV groups variants and extra images, quotes multiline HTML, and omits pricing and stock quantities', () => {
  const p=product();p.title='Dress, "Été"';p.description='<p>First line</p>\n<p>Second line</p>';
  p.variants=p.variants.slice(0,2);p.images.forEach(i=>i.validation='valid');
  const csv=toCsv(batch(p));
  assert.equal(csv.split('\n')[0],CSV_HEADERS.join(','));
  assert.match(csv,/"Dress, ""Été"""/);assert.match(csv,/"<p>First line<\/p>\n<p>Second line<\/p>"/);
  assert.match(csv,/,false,draft,Size,UK 4,Color,Black,/);
  assert.equal(csv.split(p.handle).length-1,4);
  assert.doesNotMatch(CSV_HEADERS.join(','),/price|cost|inventory quantity|currency/i);
  assert.ok(csv.endsWith('\n'));assert.ok(!csv.includes('\r'));
});
test('CSV skips invalid or excluded images and JSON keeps availability/errors with no price fields', () => {
  const p=product();p.images[0].validation='valid';p.images[1].validation='valid';p.images[1].included=false;
  const b=batch(p);b.items.push({id:'bad',url:'bad',status:'failed',error:'Invalid URL.'});
  const csv=toCsv(b);assert.ok(csv.includes(p.images[0].url));assert.ok(!csv.includes(p.images[1].url));assert.ok(!csv.includes(p.images[2].url));
  const json=toJson(b);assert.equal(json.schemaVersion,'1.1');assert.equal(json.errors.length,1);assert.equal(json.products[0].images.length,3);
  assert.doesNotMatch(JSON.stringify(json),/"(?:price|prices|currency|cost|inventory)"\s*:/i);
  b.items[0].product!.included=false;assert.equal(toJson(b).products.length,0);
});

test('Every variant enables Shopify inventory tracking; extra image rows do not create inventory records',()=>{
  const p=product();p.title='Test';p.description='';p.brand='Brand';p.productType='Dress';
  p.variants=p.variants.slice(0,2);p.variants[0].availability='available';p.variants[1].availability='sold_out';
  p.images.forEach(i=>i.validation='valid');
  const rows=toCsv(batch(p)).trimEnd().split('\n').slice(1).map(line=>line.split(','));
  const tracker=CSV_HEADERS.indexOf('Inventory tracker');
  const policy=CSV_HEADERS.indexOf('Continue selling when out of stock');
  const fulfillment=CSV_HEADERS.indexOf('Fulfillment service');
  assert.equal(rows.length,4);
  for(const row of rows.slice(0,2))assert.deepEqual([row[tracker],row[policy],row[fulfillment]],['shopify','deny','manual']);
  for(const row of rows.slice(2))assert.deepEqual([row[tracker],row[policy],row[fulfillment]],['','','']);
  assert.ok(!CSV_HEADERS.includes('Inventory quantity'));
  for(const v of toJson(batch(p)).products[0].variants){
    assert.equal(v.inventoryTracker,'shopify');assert.equal(v.inventoryPolicy,'deny');assert.equal(v.fulfillmentService,'manual');
    assert.ok(!('inventoryQuantity' in v));
  }
});

test('CSV and JSON use the specified retailer vendor instead of the product brand',()=>{
  for(const [retailer,vendor] of [['asos','ASOS'],['boohoo','Boohoo'],['prettylittlething','Pretty Little Thing']] as const){
    const p=product(retailer);p.title='Test';p.description='';p.brand='A different product brand';p.productType='Dress';
    const row=toCsv(batch(p)).split('\n')[1].split(',');
    assert.equal(row[CSV_HEADERS.indexOf('Vendor')],vendor);
    const json=toJson(batch(p));assert.equal(json.products[0].vendor,vendor);assert.equal(json.products[0].brand,'A different product brand');
  }
});
test('Image validation recognizes actual image signatures instead of HTML with an image extension', () => {
  assert.equal(imageKind(Buffer.from('<html>denied</html>')),undefined);
  assert.equal(imageKind(Buffer.from([255,216,255,224])),'jpg');
});

test('Warehouse CSV matches product variants and initializes only the specified unstocked location', () => {
  for (const retailer of ['asos','boohoo','prettylittlething'] as const) {
    const p = product(retailer); p.title = 'Test'; p.description = ''; p.productType = '';
    const b = batch(p);
    b.items.push({ ...b.items[0], id: 'duplicate' });
    b.items.push({ id: 'excluded', url: 'excluded', status: 'success', product: { ...p, id: 'excluded', included: false } });
    b.items.push({ id: 'failed', url: 'bad', status: 'failed' });
    const inventory = toInventoryCsv(b, 'Warehouse').trimEnd().split('\n').map(line => line.split(','));
    assert.deepEqual(inventory.shift(), INVENTORY_HEADERS);
    assert.equal(inventory.length, p.variants.length);
    const productRows = toCsv(b).trimEnd().split('\n').slice(1).map(line => line.split(','));
    inventory.forEach((row, index) => {
      assert.equal(row[0], productRows[index][0]);
      assert.deepEqual(row.slice(2, 6), productRows[index].slice(7, 11));
      assert.equal(row[8], productRows[index][11]);
      assert.deepEqual(row.slice(9), ['Warehouse', 'not stocked', '0']);
    });
    assert.doesNotMatch(inventory.join(','), /https:|sold_out/);
    assert.doesNotMatch(INVENTORY_HEADERS.join(','), /price|cost|currency/i);
  }
});

test('Inventory CSV preserves color-only/default options, missing SKUs and quoted location names', () => {
  const p = product(); p.title = 'Été, "dress"';
  p.variants = [{ id: 'color', color: 'Blue', availability: 'unknown' }];
  assert.match(toInventoryCsv(batch(p), 'Warehouse, "Accra"'), /Color,Blue,,,,,,"Warehouse, ""Accra""",not stocked,0/);
  p.variants = [{ id: 'default', availability: 'unknown' }];
  assert.match(toInventoryCsv(batch(p), 'Warehouse'), /Title,Default Title,,,,,,Warehouse,not stocked,0/);
  p.variants = [{ id: 'size', size: 'UK 8', availability: 'sold_out' }];
  assert.match(toInventoryCsv(batch(p), 'warehouse'), /Size,UK 8,,,,,,warehouse,not stocked,0/);
});

test('Inventory export rejects invalid locations and incomplete or unselected products', () => {
  const p = product();
  for (const location of [undefined, [], '', ' ', 'x'.repeat(256), 'Warehouse\nShop', '=SUM(1)', '\tWarehouse']) {
    assert.throws(() => toInventoryCsv(batch(p), location), /location name/);
  }
  p.variants = []; assert.throws(() => toInventoryCsv(batch(p), 'Warehouse'), /Verify sizes/);
  p.included = false; assert.throws(() => toInventoryCsv(batch(p), 'Warehouse'), /Select at least/);
});
test('Mixed batch validates input, deduplicates, enforces concurrency, isolates failures and retries', async () => {
  const active=new Set<string>();let parallel=0,max=0;let fail=true;
  const jobs=new Jobs(async (url,r,signal)=>{
    assert.ok(!active.has(r),'One active request per retailer');active.add(r);parallel++;max=Math.max(max,parallel);
    try {await pause(20);signal.throwIfAborted();if(r==='boohoo'&&fail)throw new Error('Verification needed');return {...product(r),id:url};}
    finally{active.delete(r);parallel--;}
  });
  const b=jobs.create([urls.asos,urls.asos,`${urls.asos}?country=US`,urls.boohoo,urls.prettylittlething,'invalid']);
  await finished(jobs,b.id);assert.equal(b.duplicates,1);assert.ok(max<=2);assert.equal(b.items.filter(i=>i.status==='success').length,3);
  assert.equal(b.items.find(i=>i.retailer==='boohoo')!.status,'needs_browser');assert.equal(b.items.find(i=>i.url==='invalid')!.status,'failed');
  fail=false;jobs.retry(b.id,b.items.find(i=>i.retailer==='boohoo')!.id);await finished(jobs,b.id);assert.equal(b.items.filter(i=>i.status==='success').length,4);
});
test('Cancellation stops pending work and retains already extracted products', async () => {
  const jobs=new Jobs(async (_url,r,signal)=>{await pause(40);signal.throwIfAborted();return product(r);});
  const b=jobs.create([urls.asos,`${urls.asos}?country=US`,urls.boohoo]);await jobs.cancel(b.id);await pause(70);
  assert.ok(b.items.every(i=>i.status==='cancelled'));assert.equal(b.running,false);
  jobs.retry(b.id,b.items[0].id);await finished(jobs,b.id);assert.equal(b.items[0].status,'success');
  await jobs.cancel(b.id);assert.equal(b.items[0].status,'success');
});
test('Edits whitelist fields, sanitize descriptions, preserve variants, and update image selection', async () => {
  const jobs=new Jobs(async()=>product());const b=jobs.create([urls.asos]);await finished(jobs,b.id);const item=b.items[0];
  jobs.update(b.id,item.id,{title:'My dress',description:'<ul><li>Cotton</li></ul><script>bad</script>',images:[{id:item.product!.images[0].id,included:false}],price:50});
  assert.equal(item.product!.title,'My dress');assert.equal(item.product!.description,'<ul><li>Cotton</li></ul>');assert.equal(item.product!.images[0].included,false);
  assert.equal(item.product!.variants.length,8);assert.ok(!('price' in item.product!));
});

test('ZIP contains ordered images and a manifest describing failed downloads', async () => {
  const p=product(); p.images=p.images.slice(0,2); const output=new PassThrough();const parts:Buffer[]=[];
  output.on('data',chunk=>parts.push(Buffer.from(chunk)));
  const complete=streamFinished(output);
  await writeZip(batch(p),output,new AbortController().signal,async url=>{
    if(url===p.images[1].url)throw new Error('Image unavailable');
    return {bytes:Buffer.from([255,216,255,224]),url,status:200,headers:{'content-type':'image/jpeg'},extension:'jpg'};
  });
  await complete;
  const zip=Buffer.concat(parts);assert.equal(zip.readUInt32LE(0),0x04034b50);
  const files=new Map<string,Buffer>();
  for(let i=0;i<zip.length-46;i++){
    if(zip.readUInt32LE(i)!==0x02014b50)continue;
    const method=zip.readUInt16LE(i+10),size=zip.readUInt32LE(i+20),nameLength=zip.readUInt16LE(i+28),local=zip.readUInt32LE(i+42);
    const name=zip.subarray(i+46,i+46+nameLength).toString();
    const start=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28);const compressed=zip.subarray(start,start+size);
    files.set(name,method===8?inflateRawSync(compressed):compressed);
  }
  assert.equal(files.size,2);assert.ok([...files.keys()].some(k=>k.startsWith(`${p.handle}/01-`)));
  const manifest=JSON.parse(files.get('manifest.json')!.toString());assert.equal(manifest.images.length,2);
  assert.ok(manifest.images[0].file.endsWith('.jpg'));assert.equal(manifest.images[1].error,'Image unavailable');
});

test('Assisted browser supports resume and close without losing completed products',async()=>{
  let closes=0;
  const fakeBrowser=async (url:string)=>({browser:{on(){}},context:{},page:{url:()=>url,content:async()=>fixture('asos')},entryUrl:url,close:async()=>{closes++;}}) as any;
  const jobs=new Jobs(async()=>{throw new Error('Blocked');},fakeBrowser,async p=>p);
  const b=jobs.create([urls.asos]);await finished(jobs,b.id);const item=b.items[0];
  await jobs.beginBrowser(b.id,item.id);assert.equal(item.status,'awaiting_user');assert.equal(b.running,true);
  await jobs.resumeBrowser(b.id,item.id);assert.equal(item.status,'success');assert.equal(item.product!.variants.length,8);assert.equal(closes,1);assert.equal(b.running,false);
  await jobs.beginBrowser(b.id,item.id);await jobs.endBrowser(b.id,item.id);assert.equal(item.status,'needs_browser');assert.equal(closes,2);
  assert.ok(item.product);
});

test('Assisted browser cancellation releases the slot and closes the session',async()=>{
  let closed=false;
  const jobs=new Jobs(async()=>{throw new Error('Blocked');},async url=>({browser:{on(){}},context:{},page:{url:()=>url},entryUrl:url,close:async()=>{closed=true;}}) as any);
  const b=jobs.create([urls.asos]);await finished(jobs,b.id);
  await jobs.beginBrowser(b.id,b.items[0].id);await jobs.cancel(b.id);
  assert.equal(closed,true);assert.equal(b.items[0].status,'cancelled');assert.equal(b.running,false);
});

test('A repeated ASOS bootstrap stub does not mask the complete JSON assignment',()=>{
  const html='window.asos.pdp.config.product = { id: 1 };\n'+fixture('asos');
  assert.equal(parseProduct(html,urls.asos,'asos').variants.length,8);
});

test('ASOS selects the largest published rendition for each gallery asset, preserving order and ignoring unrelated images',()=>{
  const originals=product().images.map(i=>i.url);
  const large=(url:string)=>`${url}?$n_1920w$&wid=1926&fit=constrain`;
  const html=fixture('asos')+originals.slice().reverse().map(url=>`<img src="${url}?wid=44" srcset="${url}?wid=317 317w, ${url}?wid=750 750w, ${large(url)} 1926w"><img src="${url}?wid=2500&fit=crop">`).join('')+
    '<img srcset="https://images.asos-media.com/products/unrelated/999-1-pink?wid=4000 4000w">';
  const p=parseProduct(html,urls.asos,'asos');
  assert.deepEqual(p.images.map(i=>i.url),originals.map(large));
  p.images.forEach(i=>i.validation='valid');
  const csv=toCsv(batch(p));const json=toJson(batch(p));
  for(const url of originals.map(large)){assert.ok(csv.includes(url));assert.ok(json.products[0].images.some(i=>i.url===url));}
});

test('ASOS keeps the known URL when no larger rendition is exposed and upgrades schema fallback images',()=>{
  const original=product().images[0].url;
  assert.equal(product().images[0].url,original);
  const html=`<script type="application/ld+json">${JSON.stringify({'@type':'Product',name:'Dress',image:original})}</script><picture><source srcset="${original}?wid=1500&amp;fit=constrain 1500w"></picture>`;
  const p=parseProduct(html,urls.asos,'asos');
  assert.equal(p.images[0].url,`${original}?wid=1500&fit=constrain`);
});
