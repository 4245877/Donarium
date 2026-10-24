import type { Pool, QueryResultRow } from 'pg';
import type { Asset, CatalogQuery, Category, Product, ProductSummary } from '@donarium/shared';
import type { CatalogRepository } from './repository.js';

interface ProductRow extends QueryResultRow {
  id: string; sku: string; title: string; description: string;
  image_url: string | null; image_alt: string | null; source_url: string | null;
  categories: Category[]; tags: string[]; asset_count: string;
  created_at: Date; updated_at: Date;
}

const selection = `p.id, p.sku, p.title, p.description, p.image_url, p.image_alt,
  p.source_url, p.created_at, p.updated_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name) ORDER BY c.name, c.id)
    FROM product_categories pc JOIN categories c ON c.id = pc.category_id WHERE pc.product_id = p.id), '[]'::jsonb) AS categories,
  COALESCE((SELECT jsonb_agg(t.name ORDER BY t.name)
    FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = p.id), '[]'::jsonb) AS tags,
  (SELECT count(*) FROM assets a WHERE a.product_id = p.id)::text AS asset_count`;

function summary(row: ProductRow): ProductSummary {
  return {
    id: row.id, sku: row.sku, title: row.title, description: row.description,
    image: row.image_url ? { url: row.image_url, alt: row.image_alt ?? row.title } : null,
    categories: row.categories, tags: row.tags, assetCount: Number(row.asset_count),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresRepository implements CatalogRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async list(query: CatalogQuery): Promise<{ items: ProductSummary[]; total: number }> {
    const parameters: unknown[] = [];
    const conditions: string[] = [];
    const search = query.q.trim();
    if (search) {
      parameters.push(search);
      // Escape LIKE wildcards: user input is literal text, never SQL or a pattern.
      parameters.push(`%${search.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(`(p.search_vector @@ plainto_tsquery('simple', $1)
        OR p.search_text LIKE $2 ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM product_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.product_id = p.id AND lower(t.name) LIKE $2 ESCAPE '\\'))`);
    }
    if (query.category) {
      parameters.push(query.category);
      conditions.push(`EXISTS (SELECT 1 FROM product_categories pc JOIN categories c ON c.id = pc.category_id
        WHERE pc.product_id = p.id AND c.slug = $${parameters.length})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await this.pool.query<{ total: string }>(`SELECT count(*)::text AS total FROM products p ${where}`, parameters);
    const limit = Math.min(100, Math.max(1, query.pageSize));
    const offset = (Math.max(1, query.page) - 1) * limit;
    parameters.push(limit, offset);
    const order = query.sort === 'title' ? 'p.title ASC, p.id ASC' : 'p.created_at DESC, p.id ASC';
    const rows = await this.pool.query<ProductRow>(`SELECT ${selection} FROM products p ${where}
      ORDER BY ${order} LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`, parameters);
    return { items: rows.rows.map(summary), total: Number(count.rows[0]?.total ?? 0) };
  }

  async get(id: string): Promise<Product | null> {
    const result = await this.pool.query<ProductRow>(`SELECT ${selection} FROM products p WHERE p.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const assets = await this.pool.query<Asset>(`SELECT id, kind, name, media_type AS "mediaType",
      size_bytes::text AS "sizeBytes", sha256, version, storage_id AS "storageId",
      relative_path AS "relativePath", external_url AS "externalUrl"
      FROM assets WHERE product_id = $1 ORDER BY created_at ASC, id ASC`, [id]);
    return { ...summary(row), sourceUrl: row.source_url, assets: assets.rows };
  }

  async categories(): Promise<Category[]> {
    const result = await this.pool.query<Category>('SELECT id, slug, name FROM categories ORDER BY name ASC, id ASC');
    return result.rows;
  }
}

export function createPostgresRepository(pool: Pool): CatalogRepository {
  return new PostgresRepository(pool);
}
