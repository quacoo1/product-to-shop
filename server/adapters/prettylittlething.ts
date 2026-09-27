import { extractCommerce } from './commerce.js';
export const extractPrettyLittleThing = (html: string, url: string) => extractCommerce(html, url, 'prettylittlething');
