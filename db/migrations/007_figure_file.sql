-- A figure is an existing physical file reference, never an uploaded copy.
CREATE UNIQUE INDEX assets_product_figure_idx ON assets(product_id)
  WHERE metadata->>'role' = 'figure' AND retired_at IS NULL;
