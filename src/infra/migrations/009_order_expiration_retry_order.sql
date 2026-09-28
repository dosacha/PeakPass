-- Retain the original payment deadline; only failed attempts rotate to the back of the due queue.
ALTER TABLE orders ADD COLUMN expiration_last_failed_at TIMESTAMPTZ;

CREATE INDEX idx_orders_pending_expiration_retry ON orders
  (COALESCE(expiration_last_failed_at, payment_deadline_at), payment_deadline_at, id)
  WHERE status = 'pending' AND payment_deadline_at IS NOT NULL;
