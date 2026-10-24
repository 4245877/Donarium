export const APP_VERSION = '0.1.0';
export type DataMode = 'demo' | 'postgres';
export interface Category { id: string; slug: string; name: string }
export interface ProductImage { url: string; alt: string }
export interface ProductSummary {
  id: string; sku: string; title: string; description: string;
  categories: Category[]; tags: string[]; image: ProductImage | null;
  assetCount: number; createdAt: string; updatedAt: string;
}
export interface Asset {
  id: string; kind: 'image' | 'model' | 'archive' | 'source' | 'other';
  name: string; mediaType: string; sizeBytes: string | null; sha256: string | null;
  version: string | null; storageId: string | null; relativePath: string | null;
  externalUrl: string | null;
}
export interface Product extends ProductSummary { assets: Asset[]; sourceUrl: string | null }
export interface CatalogQuery { q: string; category: string; page: number; pageSize: number; sort: 'newest' | 'title' }
export interface CatalogResponse {
  items: ProductSummary[]; total: number; page: number; pageSize: number;
  mode: DataMode; categories: Category[];
}
export interface HealthResponse {
  status: 'ok' | 'degraded'; version: string; mode: DataMode;
  database: 'not-configured' | 'connected' | 'unavailable'; uptime: number;
}
export interface SystemResponse {
  name: string; version: string; mode: DataMode; readOnly: true;
  storage: string; features: { catalog: true; search: true; uploads: false; import: false; export: false };
}
export interface ApiError { error: { code: string; message: string; requestId: string } }
