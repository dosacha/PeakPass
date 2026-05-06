CREATE INDEX IF NOT EXISTS idx_payment_records_order_created
  ON payment_records(order_id, created_at DESC);

ALTER TABLE tickets DROP COLUMN IF EXISTS qr_code;
