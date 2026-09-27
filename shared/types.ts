export type Retailer = 'asos' | 'boohoo' | 'prettylittlething';
export const RETAILER_VENDORS: Record<Retailer, string> = {
  asos: 'ASOS',
  boohoo: 'Boohoo',
  prettylittlething: 'Pretty Little Thing',
};
export type Availability = 'available' | 'sold_out' | 'unknown';
export interface RequestedSelection {
  color?: string;
  sizes: string[];
  notes: string[];
  quantityChecks?: { scope: 'product' | 'colour'; expected: number; actual: number }[];
}
export interface ProductInput { url: string; selection?: RequestedSelection; }
export interface Variant {
  requestedQuantity?: number;
  id: string;
  size?: string;
  color?: string;
  sku?: string;
  availability: Availability;
}
export interface ProductImage {
  id: string;
  url: string;
  alt: string;
  included: boolean;
  validation: 'valid' | 'invalid';
  error?: string;
}
export interface Product {
  requestedSelection?: RequestedSelection;
  selectionErrors?: string[];
  id: string;
  handle: string;
  retailer: Retailer;
  sourceUrl: string;
  sourceId: string;
  extractedAt: string;
  title: string;
  description: string;
  brand: string;
  productType: string;
  productCode?: string;
  color?: string;
  variants: Variant[];
  images: ProductImage[];
  warnings: string[];
  included: boolean;
}
export type ItemStatus = 'queued' | 'extracting' | 'needs_browser' | 'awaiting_user' | 'success' | 'failed' | 'cancelled';
export interface ExtractionResult {
  selection?: RequestedSelection;
  id: string;
  url: string;
  retailer?: Retailer;
  status: ItemStatus;
  product?: Product;
  error?: string;
}
export interface Batch {
  id: string;
  createdAt: string;
  items: ExtractionResult[];
  duplicates: number;
  cancelled: boolean;
  running: boolean;
}
