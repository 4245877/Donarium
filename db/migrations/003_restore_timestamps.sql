-- Restore transactions preserve exported timestamps without disabling any integrity triggers.
CREATE OR REPLACE FUNCTION set_product_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('donarium.preserve_updated_at', true) IS DISTINCT FROM 'on' THEN
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE INDEX products_lower_title_idx ON products (lower(title), id);
