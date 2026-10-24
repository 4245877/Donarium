import { demoCategories, demoProducts } from '../apps/api/src/catalog/demo.js';
import { databaseForMaintenance, reportMaintenanceError } from './database-cli.js';

const demoStorageId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

async function seed(): Promise<void> {
  const pool = databaseForMaintenance();
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The seed is an explicit operation for a fresh database, never an upsert into real data.
      await client.query('LOCK TABLE products, categories, tags, storage_locations IN EXCLUSIVE MODE');
      const existing = await client.query<{ occupied: boolean }>(`SELECT
        EXISTS (SELECT 1 FROM products) OR EXISTS (SELECT 1 FROM categories)
        OR EXISTS (SELECT 1 FROM tags) OR EXISTS (SELECT 1 FROM storage_locations) AS occupied`);
      if (existing.rows[0]?.occupied) throw new Error('Seed requires an empty library; no data was changed.');
      await client.query('INSERT INTO storage_locations (id, key, name, kind) VALUES ($1, $2, $3, $4)',
        [demoStorageId, 'DEMO_UNAVAILABLE', 'Демонстрация — оригинальные файлы отсутствуют', 'local']);
      for (const category of demoCategories) {
        await client.query('INSERT INTO categories (id, slug, name) VALUES ($1, $2, $3)', [category.id, category.slug, category.name]);
      }
      for (const product of demoProducts) {
        await client.query(`INSERT INTO products
          (id, sku, title, description, image_url, image_alt, source_url, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [product.id, product.sku, product.title, product.description, product.image?.url ?? null,
          product.image?.alt ?? null, product.sourceUrl, product.createdAt, product.updatedAt]);
        for (const category of product.categories) {
          await client.query('INSERT INTO product_categories (product_id, category_id) VALUES ($1, $2)', [product.id, category.id]);
        }
        for (const tag of product.tags) {
          const result = await client.query<{ id: string }>(`INSERT INTO tags (name) VALUES ($1)
            ON CONFLICT (lower(name)) DO UPDATE SET name = tags.name RETURNING id`, [tag]);
          await client.query('INSERT INTO product_tags (product_id, tag_id) VALUES ($1, $2)', [product.id, result.rows[0]!.id]);
        }
        for (const asset of product.assets) {
          await client.query(`INSERT INTO assets
            (id, product_id, kind, name, media_type, size_bytes, sha256, version, storage_id, relative_path, external_url)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [asset.id, product.id, asset.kind, asset.name, asset.mediaType, asset.sizeBytes, asset.sha256,
            asset.version, demoStorageId, asset.relativePath, null]);
        }
      }
      await client.query('COMMIT');
      console.log(`Seed inserted ${demoProducts.length} demonstration records. Original model files are not included.`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

await seed().catch(reportMaintenanceError);
