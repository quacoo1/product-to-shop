// Developer utility: reduce previously downloaded public HTML to product-only fixtures.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { load } from 'cheerio';
import { assignment, schemaProduct, remixRoute } from '../server/adapters/common.js';
await mkdir('tests/fixtures', { recursive: true });
for (const [file, retailer] of [['asos','asos'],['boohoo','boohoo'],['plt-product','prettylittlething']]) {
  const html = await readFile(`.local/samples/${file}.html`, 'utf8');
  const schema = schemaProduct(load(html));
  delete schema.offers;
  let fixture = `<html><head><script type="application/ld+json">${JSON.stringify(schema)}</script></head><body>`;
  if (retailer === 'asos') {
    const p = assignment(html, 'window.asos.pdp.config.product');
    const product = Object.fromEntries(['id','name','productCode','productType','brandName','variants','images'].map(k => [k,p[k]]));
    const stock = assignment(html, 'window.asos.pdp.config.stockPriceResponse').map((p: any) => ({ productId:p.productId, variants:p.variants.map((v: any)=>({id:v.id,isInStock:v.isInStock})) }));
    fixture += `<script>window.asos.pdp.config.product = ${JSON.stringify(product)};\nwindow.asos.pdp.config.stockPriceResponse = '${JSON.stringify(stock)}';\nwindow.asos.pdp.config.productDescription = ${JSON.stringify(assignment(html, 'window.asos.pdp.config.productDescription'))};</script>`;
  } else {
    const route = remixRoute(html)!;
    const product = { id:route.product.id, key:route.product.key, name:route.product.name, description:route.product.description,
      variants:route.product.variants.map((v: any)=>({ id:v.id,sku:v.sku,isOnStock:v.isOnStock,attributes:Object.fromEntries(['brand','size','colour','colourLabel','styleTaxonomy','categoryTaxonomy','detailsAndCare'].map(k=>[k,v.attributes[k]])),images:v.images })) };
    const data = {state:{loaderData:{'routes/($locale)/product/$slug':{product,defaultColour:product.variants.find((v: any)=>v.id===route.defaultColour?.id)}}}};
    fixture += `<script>window.__remixContext = ${JSON.stringify(data)};</script>`;
  }
  await writeFile(`tests/fixtures/${retailer}.html`,`${fixture}</body></html>`);
}
