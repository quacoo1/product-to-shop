import { load } from 'cheerio';
import { assignment, availability, finish, list, schemaProduct, str } from './common.js';
import type { Variant } from '../../shared/types.js';
import { asosGalleryImages } from './asos-images.js';

export function extractAsos(html: string, url: string) {
  const $ = load(html);
  const schema = schemaProduct($);
  const product = assignment(html, 'window.asos.pdp.config.product') ?? {};
  const stock = list(assignment(html, 'window.asos.pdp.config.stockPriceResponse')).find(p => String(p.productId) === String(product.id));
  const wantedId = new URL(url).searchParams.get('colourWayId') || new URL(url).searchParams.get('colourwayid');
  const allVariants = list(product.variants);
  const color = str((wantedId ? allVariants.find(v => String(v.colourWayId) === wantedId)?.colour : schema.color) || allVariants.find(v => v.isPrimary)?.colour || allVariants[0]?.colour);
  if (wantedId && !allVariants.some(v => String(v.colourWayId) === wantedId)) throw new Error('The requested ASOS color could not be verified.');
  const variants: Variant[] = allVariants.filter(v => !color || v.colour === color).map(v => {
    const state = list(stock?.variants).find(s => s.id === v.variantId);
    return { id: str(v.variantId), size: str(v.size || v.brandSize) || undefined, color: str(v.colour) || undefined,
      sku: str(v.sku) || undefined, availability: availability(state?.isInStock) };
  });
  const detailsData = assignment(html, 'window.asos.pdp.config.productDescription');
  const visibleDetails = $('[data-testid="productDescriptionDetails"]').first().html();
  const detail = $('[data-testid="productDescription"], #product-details, .product-description').first().html();
  const care = $('[data-testid="aboutMe"], [data-testid="careInfo"], .about-me, .care-info').map((_, el) => $(el).html()).get().join('');
  const gallery = list(product.images).filter(i => i.isVisible !== false && (!i.colour || i.colour === color) && !/swatch/i.test(i.imageType)).map(i => str(i.url));
  const imageUrls = gallery.length ? gallery : list(schema.image).map(i => str(i?.url || i?.contentUrl || i)).filter(Boolean);
  return finish(html, url, 'asos', {
    sourceId: str(product.id), productCode: str(product.productCode), title: str(product.name), brand: str(product.brandName), productType: str(product.productType?.name),
    description: visibleDetails || (detailsData?.productDescription ? [
      str(detailsData.productDescription),
      product.productCode ? `<p>Product Code: ${str(product.productCode)}</p>` : '',
      ...['careInfo', 'aboutMe', 'brandDescription'].filter(key => detailsData[`${key}Visible`] !== false && detailsData[key]).map(key => `<p>${str(detailsData[key])}</p>`),
    ].join('\n') : detail ? `${detail}${care ? `<h3>Fabric & care</h3>${care}` : ''}` : undefined),
    color, variants, images: asosGalleryImages($, imageUrls),
  }, { description: '[data-testid="productDescription"], #product-details, .product-description', gallery: '[data-testid="product-gallery"] img, .gallery-image img', sizes: '#main-size-select option, select[data-testid="size-select"] option' });
}
