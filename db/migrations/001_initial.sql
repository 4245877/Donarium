CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE CHECK (length(sku) BETWEEN 1 AND 100),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  description text NOT NULL DEFAULT '',
  image_url text,
  image_alt text,
  source_url text CHECK (source_url IS NULL OR source_url ~ '^https?://[^/[:space:]]+'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  search_text text GENERATED ALWAYS AS (lower(title || ' ' || sku || ' ' || description)) STORED,
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', title), 'A') ||
    setweight(to_tsvector('simple', sku), 'A') ||
    setweight(to_tsvector('simple', description), 'B')
  ) STORED
);
CREATE INDEX products_recent_idx ON products (created_at DESC, id);
CREATE INDEX products_title_idx ON products (title, id);
CREATE INDEX products_search_idx ON products USING gin (search_vector);
CREATE INDEX products_substring_idx ON products USING gin (search_text gin_trgm_ops);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  parent_id uuid REFERENCES categories(id) ON DELETE RESTRICT,
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE TABLE product_categories (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, category_id)
);
CREATE INDEX product_categories_category_idx ON product_categories (category_id, product_id);

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100)
);
CREATE UNIQUE INDEX tags_name_unique_idx ON tags (lower(name));
CREATE INDEX tags_search_idx ON tags USING gin (lower(name) gin_trgm_ops);
CREATE TABLE product_tags (
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, tag_id)
);
CREATE INDEX product_tags_tag_idx ON product_tags (tag_id, product_id);

-- Stable identities belong in the database. Roots/hostnames/credentials live in environment configuration.
CREATE TABLE storage_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('local', 'http'))
);

CREATE TABLE assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'model', 'archive', 'source', 'other')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  media_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint CHECK (size_bytes >= 0),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  version text,
  storage_id uuid REFERENCES storage_locations(id) ON DELETE RESTRICT,
  relative_path text CHECK (
    relative_path IS NULL OR (
      length(relative_path) > 0 AND relative_path !~ '(^/|\\|(^|/)\.\.(/|$)|(^|/)\.(/|$)|//)'
    )
  ),
  external_url text CHECK (external_url IS NULL OR external_url ~ '^https?://[^/[:space:]]+'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (storage_id IS NOT NULL AND relative_path IS NOT NULL AND external_url IS NULL) OR
    (storage_id IS NULL AND relative_path IS NULL AND external_url IS NOT NULL)
  )
);
CREATE INDEX assets_product_idx ON assets (product_id, created_at, id);
CREATE INDEX assets_sha256_idx ON assets (sha256) WHERE sha256 IS NOT NULL;

-- An optional integration maps to independent external IDs; no SKUFnya database coupling.
CREATE TABLE external_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  system text NOT NULL CHECK (length(system) BETWEEN 1 AND 100),
  external_id text NOT NULL CHECK (length(external_id) BETWEEN 1 AND 300),
  url text CHECK (url IS NULL OR url ~ '^https?://[^/[:space:]]+'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  UNIQUE (system, external_id)
);
CREATE INDEX external_links_product_idx ON external_links (product_id);

CREATE FUNCTION set_product_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_product_updated_at();
