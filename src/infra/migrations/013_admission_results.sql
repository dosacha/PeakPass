-- Durable admission consumption ledger (admission-v1 §5). One row per admission, written in the
-- same transaction as its reservation or order. Existing reservations and orders get no row.
CREATE TABLE admission_results (
  admission_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  event_id UUID NOT NULL REFERENCES events(id),
  epoch UUID NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('reservation', 'direct-checkout')),
  fingerprint TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('consumed', 'rejected', 'closed')),
  reservation_id UUID UNIQUE REFERENCES reservations(id),
  order_id UUID UNIQUE REFERENCES orders(id),
  error_code TEXT,
  http_status INT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT admission_results_shape_check CHECK (
    (outcome = 'consumed'
      AND error_code IS NULL AND http_status IS NULL AND error_message IS NULL
      AND ((operation = 'reservation' AND reservation_id IS NOT NULL AND order_id IS NULL)
        OR (operation = 'direct-checkout' AND order_id IS NOT NULL AND reservation_id IS NULL)))
    OR
    (outcome IN ('rejected', 'closed')
      AND reservation_id IS NULL AND order_id IS NULL
      AND error_code IS NOT NULL AND error_message IS NOT NULL
      AND http_status IS NOT NULL AND http_status BETWEEN 400 AND 499)
  )
);

-- Identity and outcome are immutable once committed. DELETE stays possible for owned cleanup only.
CREATE FUNCTION admission_results_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admission_results rows are immutable' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER admission_results_immutable BEFORE UPDATE ON admission_results
  FOR EACH ROW EXECUTE FUNCTION admission_results_reject_update();
