-- Only derived search columns are rebuilt. No product, file, or category data is removed.
-- Apply inside the migration runner's transaction after a database backup.
ALTER TABLE products ALTER COLUMN sku DROP NOT NULL;
ALTER TABLE products DROP COLUMN search_text;
ALTER TABLE products DROP COLUMN search_vector;
ALTER TABLE products ADD COLUMN search_text text GENERATED ALWAYS AS (
  lower(title || ' ' || coalesce(sku, '') || ' ' || description)
) STORED;
ALTER TABLE products ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', title), 'A') ||
  setweight(to_tsvector('simple', coalesce(sku, '')), 'A') ||
  setweight(to_tsvector('simple', description), 'B')
) STORED;
CREATE INDEX products_search_idx ON products USING gin (search_vector);
CREATE INDEX products_substring_idx ON products USING gin (search_text gin_trgm_ops);
ALTER TABLE products ADD COLUMN status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'processing'));
ALTER TABLE products ADD COLUMN cover_asset_id uuid REFERENCES assets(id) ON DELETE SET NULL;
CREATE INDEX products_updated_idx ON products (updated_at DESC, id);
CREATE INDEX products_status_idx ON products (status, created_at DESC, id);
ALTER TABLE assets ADD COLUMN origin text NOT NULL DEFAULT 'external' CHECK (origin IN ('external', 'uploaded'));
-- A single physical resource may be linked to several cards, once on each card.
CREATE UNIQUE INDEX assets_product_location_unique_idx ON assets (product_id, storage_id, relative_path)
  WHERE storage_id IS NOT NULL;
CREATE TABLE import_sources (
  storage_id uuid NOT NULL REFERENCES storage_locations(id) ON DELETE RESTRICT,
  relative_path text NOT NULL CHECK (relative_path = '' OR (
    relative_path !~ '(^/|\\|(^|/)\.\.(/|$)|(^|/)\.(/|$)|//)'
  )),
  product_id uuid NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (storage_id, relative_path)
);
