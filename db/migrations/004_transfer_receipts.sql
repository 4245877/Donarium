-- A commit receipt distinguishes a completed restore from a crash before COMMIT.
CREATE TABLE transfer_receipts (
  id uuid PRIMARY KEY,
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
