import { load } from 'cheerio';
import { finish, list, sameColor, schemaProduct, schemaVariants, selectedColor, str } from './common.js';

function pathColor(url: string): string {
  const slug = new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  const match = /-fncolorname-([\w-]+)$/i.exec(slug);
  return match ? decodeURIComponent(match[1]).replace(/[-_]+/g, ' ') : '';
}

export function extractFashionNova(html: string, url: string) {
  const $ = load(html);
  const schema = schemaProduct($);
  const variants = list(schema.hasVariant);
  const requested = selectedColor(url) || pathColor(url);
  const colors = [...new Set(variants.map(variant => str(variant.color)).filter(Boolean))];
  const color = requested ? colors.find(candidate => sameColor(candidate, requested)) : colors[0] || str(schema.color);
  if (requested && colors.length && !color) throw new Error('The linked color was not found in this product.');

  return finish(html, url, 'fashionnova', {
    sourceId: str(schema.productGroupID || schema.productID),
    productCode: str(schema.productGroupID || schema.productID),
    description: $('[data-testid="product-details-text"]').first().html() || str(schema.description),
    productType: str(schema.category),
    color: color || requested,
    variants: schemaVariants(schema, color || requested),
  }, {
    description: '[data-testid="product-details-text"], [itemprop="description"], .product-description',
    gallery: '[data-testid="product-gallery"] img, [data-testid="product-image"] img, .product-gallery img',
    sizes: '[data-testid="size-selector"] button, [data-size], select[name="size"] option',
  });
}
