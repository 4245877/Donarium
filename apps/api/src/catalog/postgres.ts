import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { Asset, CatalogQuery, Category, CategoryInput, Product, ProductInput, ProductStatus, ProductSummary } from '@donarium/shared';
import type { CatalogRepository } from './repository.js';
import type { StorageService } from '../storage/service.js';
import { saveFigureFile } from '../storage/figure.js';

interface ProductRow extends QueryResultRow {
  id: string; sku: string | null; title: string; description: string; status: ProductStatus; cover_asset_id: string | null;
  image_url: string | null; image_alt: string | null; source_url: string | null;
  categories: Category[]; tags: string[]; asset_count: string;
  created_at: Date; updated_at: Date;
}

const selection = `p.id, p.sku, p.title, p.description, p.status, p.cover_asset_id, p.image_url, p.image_alt,
  p.source_url, p.created_at, p.updated_at,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'slug', c.slug, 'name', c.name) ORDER BY c.name, c.id)
    FROM product_categories pc JOIN categories c ON c.id = pc.category_id WHERE pc.product_id = p.id), '[]'::jsonb) AS categories,
  COALESCE((SELECT jsonb_agg(t.name ORDER BY t.name)
    FROM product_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.product_id = p.id), '[]'::jsonb) AS tags,
  (SELECT count(*) FROM assets a WHERE a.product_id = p.id AND a.retired_at IS NULL)::text AS asset_count`;

function summary(row: ProductRow): ProductSummary {
  return {
    id: row.id, sku: row.sku, title: row.title, description: row.description,
    status: row.status, coverAssetId: row.cover_asset_id,
    image: row.cover_asset_id ? { url: `/api/v1/assets/${row.cover_asset_id}/thumbnail`, alt: row.title }
      : row.image_url ? { url: row.image_url, alt: row.image_alt ?? row.title } : null,
    categories: row.categories, tags: row.tags, assetCount: Number(row.asset_count),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

export class CatalogInputError extends Error {
  statusCode = 400;
}

/** Pool connections make each metadata edit atomic. A supplied client remains caller-owned. */
export class PostgresRepository implements CatalogRepository {
  constructor(private readonly pool: Pool | Pick<PoolClient, 'query' | 'release'>, private readonly storage?: StorageService) {}

  private async transaction<T>(work: (client: Pick<PoolClient, 'query'>) => Promise<T>): Promise<T> {
    if ('release' in this.pool) return work(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async list(query: CatalogQuery): Promise<{ items: ProductSummary[]; total: number }> {
    const parameters: unknown[] = [];
    const conditions: string[] = [];
    const search = query.q.trim();
    if (search) {
      parameters.push(search);
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
    if (query.tag) {
      parameters.push(query.tag);
      conditions.push(`EXISTS (SELECT 1 FROM product_tags pt JOIN tags t ON t.id = pt.tag_id
        WHERE pt.product_id = p.id AND lower(t.name) = lower($${parameters.length}))`);
    }
    if (query.status) {
      parameters.push(query.status);
      conditions.push(`p.status = $${parameters.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const count = await this.pool.query<{ total: string }>(`SELECT count(*)::text AS total FROM products p ${where}`, parameters);
    const limit = Math.min(100, Math.max(1, query.pageSize));
    const offset = (Math.max(1, query.page) - 1) * limit;
    parameters.push(limit, offset);
    const order = query.sort === 'title' ? 'lower(p.title) ASC, p.id ASC'
      : query.sort === 'updated' ? 'p.updated_at DESC, p.id ASC' : 'p.created_at DESC, p.id ASC';
    const rows = await this.pool.query<ProductRow>(`SELECT ${selection} FROM products p ${where}
      ORDER BY ${order} LIMIT $${parameters.length - 1} OFFSET $${parameters.length}`, parameters);
    return { items: rows.rows.map(summary), total: Number(count.rows[0]?.total ?? 0) };
  }

  async get(id: string): Promise<Product | null> {
    const result = await this.pool.query<ProductRow>(`SELECT ${selection} FROM products p WHERE p.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const assets = await this.pool.query<Asset>(`SELECT a.id, a.kind, a.name, a.media_type AS "mediaType",
      coalesce(f.size_bytes,a.size_bytes)::text AS "sizeBytes", coalesce(f.sha256,a.sha256) AS sha256, a.version, a.storage_id AS "storageId",
      coalesce(f.relative_path,a.relative_path) AS "relativePath", a.external_url AS "externalUrl", s.key AS "storageKey",
      a.origin, a.file_id AS "fileId", a.metadata->>'role' AS role, f.status AS "fileStatus", f.format, a.created_at AS "createdAt"
      FROM assets a LEFT JOIN storage_files f ON f.id=a.file_id LEFT JOIN storage_locations s ON s.id = coalesce(f.storage_id,a.storage_id)
      WHERE a.product_id = $1 AND a.retired_at IS NULL ORDER BY a.created_at ASC, a.id ASC`, [id]);
    return { ...summary(row), sourceUrl: row.source_url, assets: assets.rows, figureFile: assets.rows.find(asset => asset.role === 'figure') ?? null };
  }

  async categories(): Promise<Category[]> {
    const result = await this.pool.query<Category>('SELECT id, slug, name FROM categories ORDER BY name ASC, id ASC');
    return result.rows;
  }

  async createCategory(input: CategoryInput): Promise<Category> {
    const id = randomUUID();
    const slug = input.slug?.trim() || `category-${id}`;
    const result = await this.pool.query<Category>('INSERT INTO categories (id,slug,name) VALUES ($1,$2,$3) RETURNING id,slug,name',
      [id, slug, input.name.trim()]);
    return result.rows[0]!;
  }

  private async relations(client: Pick<PoolClient, 'query'>, id: string, input: ProductInput) {
    if (input.figureFile !== undefined) await saveFigureFile(client, this.storage, id, input.figureFile);
    const categoryIds = [...new Set(input.categoryIds ?? [])];
    if (categoryIds.length) {
      const existing = await client.query<{ id: string }>('SELECT id FROM categories WHERE id = ANY($1::uuid[])', [categoryIds]);
      if (existing.rowCount !== categoryIds.length) throw new CatalogInputError('Категория не найдена');
    }
    if (input.coverAssetId) {
      const cover = await client.query('SELECT id FROM assets WHERE id=$1 AND product_id=$2 AND kind=\'image\'', [input.coverAssetId, id]);
      if (!cover.rowCount) throw new CatalogInputError('Изображение не принадлежит карточке');
    }
    await client.query('DELETE FROM product_categories WHERE product_id=$1', [id]);
    for (const categoryId of categoryIds) {
      await client.query('INSERT INTO product_categories (product_id,category_id) VALUES ($1,$2)', [id, categoryId]);
    }
    await client.query('DELETE FROM product_tags WHERE product_id=$1', [id]);
    const tags = new Map((input.tags ?? []).map(tag => [tag.trim().toLocaleLowerCase('ru'), tag.trim()]));
    for (const name of tags.values()) {
      if (!name) continue;
      const tag = await client.query<{ id: string }>(`INSERT INTO tags(name) VALUES ($1)
        ON CONFLICT (lower(name)) DO UPDATE SET name=tags.name RETURNING id`, [name]);
      await client.query('INSERT INTO product_tags (product_id,tag_id) VALUES ($1,$2)', [id, tag.rows[0]!.id]);
    }
  }

  async create(input: ProductInput, id = randomUUID()): Promise<Product> {
    await this.transaction(async client => {
      await client.query(`INSERT INTO products (id,title,sku,description,status) VALUES ($1,$2,$3,$4,$5)`,
        [id, input.title.trim(), input.sku?.trim() || null, input.description?.trim() ?? '', input.status ?? 'ready']);
      await this.relations(client, id, input);
      if (input.coverAssetId) await client.query('UPDATE products SET cover_asset_id=$2 WHERE id=$1', [id, input.coverAssetId]);
    });
    return (await this.get(id))!;
  }

  async update(id: string, input: ProductInput): Promise<Product | null> {
    const changed = await this.transaction(async client => {
      const found = await client.query('SELECT id FROM products WHERE id=$1 FOR UPDATE', [id]);
      if (!found.rowCount) return false;
      await this.relations(client, id, input);
      await client.query(`UPDATE products SET title=$2,sku=$3,description=$4,status=$5,cover_asset_id=$6 WHERE id=$1`,
        [id, input.title.trim(), input.sku?.trim() || null, input.description?.trim() ?? '', input.status ?? 'ready', input.coverAssetId ?? null]);
      return true;
    });
    return changed ? this.get(id) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM products WHERE id=$1', [id]);
    return !!result.rowCount;
  }
}

export function createPostgresRepository(pool: Pool): CatalogRepository {
  return new PostgresRepository(pool);
}
