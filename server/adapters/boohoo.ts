import { extractCommerce } from './commerce.js';
export const extractBoohoo = (html: string, url: string) => extractCommerce(html, url, 'boohoo');
