-- Additive migration. Physical originals, asset UUIDs and legacy columns are retained.
CREATE TABLE storage_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_id uuid NOT NULL REFERENCES storage_locations(id) ON DELETE RESTRICT,
  relative_path text COLLATE "C" NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 4096 AND relative_path !~ '(^/|\\|(^|/)\.\.(/|$)|(^|/)\.(/|$)|//|[[:cntrl:]])'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 300),
  format text NOT NULL DEFAULT '',
  kind text NOT NULL CHECK (kind IN ('image','model','archive','source','other')),
  media_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint CHECK (size_bytes >= 0),
  sha256 text CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified','available','missing','corrupt','unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  verified_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata)='object'),
  UNIQUE(storage_id,relative_path)
);
CREATE INDEX storage_files_content_idx ON storage_files(sha256,size_bytes) WHERE sha256 IS NOT NULL;
CREATE INDEX storage_files_status_idx ON storage_files(status,id);
CREATE INDEX storage_files_name_idx ON storage_files USING gin(lower(name) gin_trgm_ops);
ALTER TABLE assets ADD COLUMN file_id uuid REFERENCES storage_files(id) ON DELETE RESTRICT;
ALTER TABLE assets ADD COLUMN retired_at timestamptz;
ALTER TABLE assets ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata)='object');
INSERT INTO storage_files(storage_id,relative_path,name,format,kind,media_type,size_bytes,sha256,created_at)
SELECT DISTINCT ON(storage_id,relative_path) storage_id,relative_path,name,
  CASE WHEN name LIKE '%.%' THEN lower(regexp_replace(name,'^.*\.','')) ELSE '' END,
  kind,media_type,size_bytes,sha256,created_at
FROM assets WHERE storage_id IS NOT NULL ORDER BY storage_id,relative_path,created_at,id;
UPDATE assets a SET file_id=f.id FROM storage_files f WHERE a.storage_id=f.storage_id AND a.relative_path=f.relative_path;
CREATE INDEX assets_file_idx ON assets(file_id,product_id) WHERE file_id IS NOT NULL;
CREATE UNIQUE INDEX assets_product_file_idx ON assets(product_id,file_id) WHERE file_id IS NOT NULL;

-- Old import/restore clients continue to work. All physical references enter the registry.
CREATE FUNCTION assets_file_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f storage_files;
BEGIN
  IF TG_OP='UPDATE' AND NEW.file_id IS NOT DISTINCT FROM OLD.file_id AND (NEW.storage_id IS DISTINCT FROM OLD.storage_id OR NEW.relative_path IS DISTINCT FROM OLD.relative_path) THEN NEW.file_id=NULL; END IF;
  IF NEW.file_id IS NOT NULL THEN
    SELECT * INTO STRICT f FROM storage_files WHERE id=NEW.file_id;
    NEW.storage_id=f.storage_id; NEW.relative_path=f.relative_path;
    NEW.size_bytes=f.size_bytes; NEW.sha256=f.sha256; NEW.external_url=NULL;
  ELSIF NEW.storage_id IS NOT NULL THEN
    INSERT INTO storage_files(storage_id,relative_path,name,format,kind,media_type,size_bytes,sha256)
    VALUES(NEW.storage_id,NEW.relative_path,NEW.name,
      CASE WHEN NEW.name LIKE '%.%' THEN lower(regexp_replace(NEW.name,'^.*\.','')) ELSE '' END,
      NEW.kind,NEW.media_type,NEW.size_bytes,NEW.sha256)
    ON CONFLICT(storage_id,relative_path) DO NOTHING;
    SELECT id INTO NEW.file_id FROM storage_files WHERE storage_id=NEW.storage_id AND relative_path=NEW.relative_path;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assets_file_reference BEFORE INSERT OR UPDATE OF file_id,storage_id,relative_path ON assets
FOR EACH ROW EXECUTE FUNCTION assets_file_reference();

CREATE TABLE storage_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','interrupted')),
  progress bigint NOT NULL DEFAULT 0,
  total bigint NOT NULL DEFAULT 0,
  parameters jsonb NOT NULL DEFAULT '{}',
  result jsonb NOT NULL DEFAULT '{}',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE storage_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid REFERENCES storage_operations(id) ON DELETE RESTRICT,
  file_id uuid REFERENCES storage_files(id) ON DELETE RESTRICT,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE storage_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  file_id uuid REFERENCES storage_files(id) ON DELETE RESTRICT,
  method text NOT NULL CHECK(method IN ('exact','stem','normalized','ambiguous','missing','manual')),
  source_name text NOT NULL DEFAULT '',
  candidates jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','applied','rejected','rolled_back')),
  snapshot jsonb NOT NULL,
  applied_snapshot jsonb,
  operation_id uuid REFERENCES storage_operations(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE storage_uploads (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK(status IN ('receiving','staged','completed','failed','interrupted','discarded')),
  size_bytes bigint,
  sha256 text,
  file_id uuid REFERENCES storage_files(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
