-- A provider transaction can receive several terminal callback keys (including
-- failure followed by corrected success). Preserve every accepted key without
-- replacing the original key on the financial payment record.
CREATE TABLE payment_callback_keys (
  idempotency_key VARCHAR(255) PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider_transaction_id VARCHAR(255) NOT NULL
);

CREATE INDEX idx_payment_callback_keys_order_id ON payment_callback_keys(order_id);

INSERT INTO payment_callback_keys (idempotency_key, order_id, provider_transaction_id)
SELECT idempotency_key, order_id, provider_transaction_id
FROM payment_records
WHERE provider_transaction_id IS NOT NULL;
