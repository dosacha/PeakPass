ALTER TABLE payment_callback_keys ADD COLUMN callback_status VARCHAR(20)
  CHECK (callback_status IN ('failed', 'settled'));

-- Only these original payment records still prove the original callback input.
-- Late successes may have overwritten failed(A) after correction(B).
-- Unmatched aliases also have no recoverable input status: retain NULL and reject reuse.
UPDATE payment_callback_keys k SET callback_status = p.status
FROM payment_records p
WHERE k.idempotency_key = p.idempotency_key
  AND k.order_id = p.order_id
  AND k.provider_transaction_id = p.provider_transaction_id
  AND (p.status = 'failed' OR (p.status = 'settled' AND NOT p.reconciliation_required));
