-- Existing orders retain NULL deadlines; only newly checked-out orders get a window.
ALTER TABLE orders ADD COLUMN payment_deadline_at TIMESTAMPTZ;

ALTER TABLE orders DROP CONSTRAINT orders_status_allowed_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_allowed_check
CHECK (status IN ('pending', 'paid', 'delivered', 'cancelled', 'expired'));

CREATE INDEX idx_orders_pending_payment_deadline
ON orders (payment_deadline_at, id)
WHERE status = 'pending' AND payment_deadline_at IS NOT NULL;

-- A late successful provider payment remains a settled fact requiring reconciliation.
ALTER TABLE payment_records
ADD COLUMN reconciliation_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payment_records ADD CONSTRAINT payment_records_reconciliation_settled_check
CHECK (NOT reconciliation_required OR status = 'settled');
