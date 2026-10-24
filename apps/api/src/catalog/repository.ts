import type { CatalogQuery, Category, CategoryInput, Product, ProductInput, ProductSummary } from '@donarium/shared';

/** This boundary keeps the demo fixture and PostgreSQL as explicit, separate modes. */
export interface CatalogRepository {
  list(query: CatalogQuery): Promise<{ items: ProductSummary[]; total: number }>;
  get(id: string): Promise<Product | null>;
  categories(): Promise<Category[]>;
  create?(input: ProductInput, id?: string): Promise<Product>;
  update?(id: string, input: ProductInput): Promise<Product | null>;
  delete?(id: string): Promise<boolean>;
  createCategory?(input: CategoryInput): Promise<Category>;
}
