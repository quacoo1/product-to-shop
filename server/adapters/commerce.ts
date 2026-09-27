import { load } from 'cheerio';
import { finish, list, remixRoute, sameColor, schemaProduct, selectedColor, str, availability } from './common.js';
import type { Retailer, Variant } from '../../shared/types.js';

// Boohoo and the current PLT storefront share the same public Remix product shape.
// Keep their entry points separate so either adapter can evolve independently.
export function extractCommerce(html: string, url: string, retailer: Retailer) {
  const $ = load(html);
  const schema = schemaProduct($);
  const route = remixRoute(html);
  const product = route?.product;
  const all = list(product?.variants);
  const requested = selectedColor(url);
  const selected = requested ? all.find(v => sameColor(str(v.attributes?.colour), requested) || sameColor(str(v.attributes?.colourLabel), requested)) : route?.defaultColour || all.find(v => v.sku === schema.sku) || all[0];
  if (requested && all.length && !selected) throw new Error('The linked color was not found in this product.');
  const attrs = selected?.attributes ?? {};
  const color = str(attrs.colourLabel || attrs.colour || schema.color || requested);
  const matched = all.filter(v => sameColor(str(v.attributes?.colourLabel || v.attributes?.colour), color));
  const variants: Variant[] = matched.map(v => ({ id: str(v.id || v.sku), size: str(v.attributes?.size) || undefined,
    color, sku: str(v.sku) || undefined, availability: availability(v.isOnStock) }));
  const description = $('[data-test-id="accordion-Description-content"]').first().html() || str(product?.description || schema.description);
  const care = $('[data-test-id="accordion-Product Details & Care-content"], [data-test-id="accordion-Fabric & Care-content"]').first().html() || str(attrs.detailsAndCareVariant || attrs.detailsAndCare);
  return finish(html, url, retailer, {
    sourceId: str(product?.id), productCode: str(product?.key || product?.id), title: str(product?.name),
    brand: str(attrs.brand), productType: str(attrs.styleTaxonomy || attrs.categoryTaxonomy), color, variants,
    description: `${description}${care ? `<h3>Product Details & Care</h3><div>${care}</div>` : ''}`,
    images: list(selected?.images).map(i => str(i.desktop?.url || i.url)),
  }, {
    description: '[data-testid="product-description"], [itemprop="description"], .product-description',
    gallery: '[data-testid="product-gallery"] img, [data-testid="product-image"] img, .product-gallery img, .product-image-container img',
    sizes: '[data-testid="size-selector"] button, [data-testid="size-button"], [data-size], select[name="size"] option',
  });
}
