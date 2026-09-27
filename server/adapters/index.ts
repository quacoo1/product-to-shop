import { extractAsos } from './asos.js';
import { extractBoohoo } from './boohoo.js';
import { extractPrettyLittleThing } from './prettylittlething.js';
import type { Retailer } from '../../shared/types.js';
export const adapters = { asos: extractAsos, boohoo: extractBoohoo, prettylittlething: extractPrettyLittleThing };
export const parseProduct = (html: string, url: string, retailer: Retailer) => adapters[retailer](html, url);
