export const APP_VERSION = '0.2.0';
export type DataMode = 'demo' | 'postgres';
export interface Category { id: string; slug: string; name: string }
export interface ProductImage { url: string; alt: string }
export type ProductStatus = 'ready' | 'processing';
export interface ProductInput {
  title: string; sku?: string | null; description?: string; status?: ProductStatus;
  categoryIds?: string[]; tags?: string[]; coverAssetId?: string | null;
}
export interface CategoryInput { name: string; slug?: string }
export interface ProductSummary {
  id: string; sku: string | null; title: string; description: string;
  status: ProductStatus; coverAssetId: string | null;
  categories: Category[]; tags: string[]; image: ProductImage | null;
  assetCount: number; createdAt: string; updatedAt: string;
}
export interface Asset {
  id: string; kind: 'image' | 'model' | 'archive' | 'source' | 'other';
  name: string; mediaType: string; sizeBytes: string | null; sha256: string | null;
  version: string | null; storageId: string | null; relativePath: string | null;
  externalUrl: string | null;
  storageKey?: string | null; origin?: 'external' | 'uploaded'; createdAt?: string;
}
export interface Product extends ProductSummary { assets: Asset[]; sourceUrl: string | null }
export interface CatalogQuery { q: string; category: string; tag?: string; status?: '' | ProductStatus; page: number; pageSize: number; sort: 'newest' | 'updated' | 'title' }
export interface CatalogResponse {
  items: ProductSummary[]; total: number; page: number; pageSize: number;
  mode: DataMode; categories: Category[];
}
export interface HealthResponse {
  status: 'ok' | 'degraded'; version: string; mode: DataMode;
  database: 'not-configured' | 'connected' | 'unavailable'; uptime: number;
}
export interface SystemResponse {
  name: string; version: string; mode: DataMode; readOnly: boolean;
  storage: string; features: { catalog: true; search: true; uploads: boolean; import: boolean; export: boolean };
}
export interface ApiError { error: { code: string; message: string; requestId: string } }
