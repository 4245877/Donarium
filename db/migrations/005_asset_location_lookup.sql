-- Folder scans recognize manually linked resources by exact logical root and file path.
-- Existing data stays intact; this complements the per-card uniqueness index.
CREATE INDEX assets_location_product_idx ON assets (storage_id, relative_path, product_id)
  WHERE storage_id IS NOT NULL;
