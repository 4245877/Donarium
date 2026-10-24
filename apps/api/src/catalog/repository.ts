import type { CatalogQuery, Category, Product, ProductSummary } from '@donarium/shared';

/** This boundary keeps the demo fixture and PostgreSQL as explicit, separate modes. */
export interface CatalogRepository {
  list(query: CatalogQuery): Promise<{ items: ProductSummary[]; total: number }>;
  get(id: string): Promise<Product | null>;
  categories(): Promise<Category[]>;
}
