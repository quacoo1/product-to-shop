import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Batch } from '../shared/types.js';

const base = `http://localhost:${process.env.PORT || 4317}`;
const { token } = await (await fetch(`${base}/api/session`)).json() as { token: string };
const headers = { 'Content-Type':'application/json', 'X-Session-Token':token };
assert.equal((await fetch(`${base}/api/batches/missing`)).status,403);
assert.equal((await fetch(`${base}/api/session`,{headers:{Origin:'https://unrelated.example'}})).status,403);
assert.equal((await fetch(`${base}/api/batches`,{method:'POST',headers,body:JSON.stringify({urls:Array(51).fill('invalid')})})).status,400);
const urls = [
  'https://www.asos.com/asos-design/asos-design-button-down-rib-with-picot-trim-midi-dress-in-black/prd/209696517',
  'https://www.boohoo.com/product/boohoo-contrast-lace-cut-out-mini-dress_gzz26440',
  'https://www.prettylittlething.com/product/prettylittlething-prettylittlething-beauty-advent-calendar-2026---worth-297_ydd23636?colour=multi',
];
const created=await fetch(`${base}/api/batches`,{method:'POST',headers,body:JSON.stringify({urls:[...urls,urls[0],'not-a-link']})});
assert.equal(created.status,201);
let batch = await created.json() as Batch;
const deadline=Date.now()+120000;
while(batch.running && Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,500));batch=await (await fetch(`${base}/api/batches/${batch.id}`,{headers})).json() as Batch;}
assert.equal(batch.running,false,'Batch completed within two minutes');
assert.equal(batch.duplicates,1);assert.equal(batch.items.filter(i=>i.status==='success').length,3);
assert.equal(batch.items.filter(i=>i.status==='failed').length,1);
const item=batch.items[0];const image=item.product!.images[0];
const edited=await fetch(`${base}/api/batches/${batch.id}/items/${item.id}`,{method:'PATCH',headers,body:JSON.stringify({productType:'QA dresses',images:[{id:image.id,included:false}]})});
assert.equal(edited.status,200);
batch=await edited.json() as Batch;assert.equal(batch.items[0].product!.images[0].included,false);
await mkdir('.local/qa',{recursive:true});
await writeFile('.local/qa/batch.json',JSON.stringify(batch,null,2));
for(const format of ['csv','json','zip']){
  const response=await fetch(`${base}/api/batches/${batch.id}/export/${format}`,{headers});
  assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());
  await writeFile(`.local/qa/products.${format}`,bytes);
  if(format==='csv'){
    const csv=bytes.toString();assert.match(csv,/QA dresses/);assert.ok(!csv.includes(image.url));assert.match(csv,/,false,draft,/);
    assert.doesNotMatch(csv.split('\n')[0],/price|inventory quantity|cost/i);
    assert.match(csv.split('\n')[0],/Inventory tracker,Continue selling when out of stock,Fulfillment service/);
    assert.match(csv,/,shopify,deny,manual,/);
  }
  if(format==='json'){const data=JSON.parse(bytes.toString());assert.equal(data.products.length,3);assert.equal(data.errors.length,1);}
  if(format==='zip')assert.equal(bytes.readUInt32LE(0),0x04034b50);
  console.log(`${format.toUpperCase()}: ${bytes.length} bytes, HTTP 200`);
}
console.log('API smoke test passed: mixed batch, deduplication, validation, edits, selections, CSV/JSON/ZIP, session and origin checks.');
