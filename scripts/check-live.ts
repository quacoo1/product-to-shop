import { mkdir, writeFile } from 'node:fs/promises';
import { extract } from '../server/extract.js';
import { productUrl } from '../server/urls.js';

const defaults = [
  'https://www.asos.com/asos-design/asos-design-button-down-rib-with-picot-trim-midi-dress-in-black/prd/209696517',
  'https://www.boohoo.com/product/boohoo-contrast-lace-cut-out-mini-dress_gzz26440',
  'https://www.prettylittlething.com/product/prettylittlething-prettylittlething-beauty-advent-calendar-2026---worth-297_ydd23636?colour=multi',
];
await mkdir('.local/live', { recursive: true });
for (const input of process.argv.slice(2).length ? process.argv.slice(2) : defaults) {
  const start = Date.now();
  try {
    const { url, retailer } = productUrl(input);
    const product = await extract(url, retailer, AbortSignal.timeout(120000));
    await writeFile(`.local/live/${retailer}.json`, JSON.stringify(product, null, 2));
    console.log(JSON.stringify({ retailer, title:product.title, variants:product.variants.length, images:product.images.length, validImages:product.images.filter(i=>i.validation==='valid').length, descriptionLength:product.description.length, warnings:product.warnings, seconds:Math.round((Date.now()-start)/1000) }));
    if (!product.variants.length || !product.images.some(i => i.validation === 'valid')) process.exitCode = 1;
  } catch (error) { console.error(input, (error as Error).message); process.exitCode = 1; }
}
