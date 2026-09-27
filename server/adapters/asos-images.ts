import type { CheerioAPI } from 'cheerio';

function assetUrl(value: string): URL | undefined {
  try {
    const url = new URL(value, 'https://images.asos-media.com');
    if (url.protocol === 'https:' && url.hostname === 'images.asos-media.com' && url.pathname.startsWith('/products/')) return url;
  } catch { /* Ignore malformed or unrelated image URLs. */ }
}

/** Match responsive renditions to known gallery assets, preserving product/color order.
 * ASOS base URLs serve a small default image, not the original-sized asset.
 * Only URLs actually published by the page are eligible; never invent CDN sizes.
 */
export function asosGalleryImages($: CheerioAPI, gallery: string[]): string[] {
  const candidates = new Map<string, { url: string; width: number; cropped: boolean }>();
  const keyFor = (url: URL) => `${url.origin}${url.pathname}`;
  const known = new Set(gallery.map(assetUrl).filter((u): u is URL => !!u).map(keyFor));

  function add(value: string, descriptor = '') {
    const url = assetUrl(value);
    if (!url || !known.has(keyFor(url))) return;
    const key = keyFor(url);
    const explicitWidth = Number(url.searchParams.get('wid')) || Number(url.searchParams.get('w'));
    const declaredWidth = /^\d+w$/.test(descriptor) ? Number(descriptor.slice(0, -1)) : 0;
    const presetWidth = Number(url.search.match(/\$n_(\d+)w\$/)?.[1]) || 0;
    const width = explicitWidth || declaredWidth || presetWidth;
    const cropped = url.searchParams.get('fit') === 'crop';
    const previous = candidates.get(key);
    // Avoid social-preview crops when the page provides the full product image.
    if (!previous || (previous.cropped && !cropped) || (previous.cropped === cropped && width > previous.width)) {
      candidates.set(key, { url: url.href, width, cropped });
    }
  }

  gallery.forEach(url => add(url));
  $('img, source, link[imagesrcset]').each((_, element) => {
    const node = $(element);
    for (const attribute of ['src', 'data-src', 'data-zoom-image', 'data-large-image']) {
      const value = node.attr(attribute);
      if (value) add(value);
    }
    for (const attribute of ['srcset', 'data-srcset', 'imagesrcset']) {
      const value = node.attr(attribute);
      if (!value) continue;
      for (const entry of value.split(',')) {
        const [url, descriptor] = entry.trim().split(/\s+/);
        if (url) add(url, descriptor);
      }
    }
  });

  return gallery.map(original => {
    const url = assetUrl(original);
    return url ? candidates.get(keyFor(url))?.url ?? original : original;
  });
}
