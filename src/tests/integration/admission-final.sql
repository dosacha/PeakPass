-- Final SQL of admission-v1 §8. One statement, no parameter: every row is a violation, and no row
-- means every check holds for every event of the database. Run it after the writers have stopped.
--
--   seat_bounds              0 <= available <= total
--   seat_equation            available + active reservations + pending/paid/delivered orders = total
--                            (a converted reservation is counted once, through its order)
--   ticket_count             a paid or delivered order has one ticket per seat, any other order none
--   ticket_identity          a ticket belongs to the user and the event of its order
--   result_target            a consumed result names a target of the same owner, event, tier,
--                            quantity and, for a direct checkout, checkout key
--   result_fingerprint       a result's fingerprint carries its own user, event, epoch and operation
--   unlinked_occupation      on a protected event every reservation and every order without a
--                            reservation has its consumed result (read it only for an event that
--                            was protected before its first purchase)
--   payment_settled          exactly a paid or delivered order has one settled payment that is no
--                            reconciliation fact
--   payment_callback_key     a provider payment record has its durable callback key
--   payment_checkout_record  an order has its one checkout payment record under its own key
WITH held AS (
  SELECT event_id, SUM(quantity) AS quantity FROM reservations WHERE status = 'active' GROUP BY event_id
), ordered AS (
  SELECT event_id, SUM(quantity) AS quantity FROM orders
  WHERE status IN ('pending', 'paid', 'delivered') GROUP BY event_id
)
SELECT 'seat_bounds' AS check_name, e.id AS event_id,
  format('available=%s total=%s', e.available_seats, e.total_seats) AS detail
FROM events e
WHERE e.available_seats < 0 OR e.available_seats > e.total_seats

UNION ALL
SELECT 'seat_equation', e.id,
  format('available=%s held=%s ordered=%s total=%s', e.available_seats,
    COALESCE(h.quantity, 0), COALESCE(o.quantity, 0), e.total_seats)
FROM events e
LEFT JOIN held h ON h.event_id = e.id
LEFT JOIN ordered o ON o.event_id = e.id
WHERE e.available_seats + COALESCE(h.quantity, 0) + COALESCE(o.quantity, 0) <> e.total_seats

UNION ALL
SELECT 'ticket_count', o.event_id,
  format('order=%s status=%s quantity=%s tickets=%s', o.id, o.status, o.quantity, t.issued)
FROM orders o
CROSS JOIN LATERAL (
  SELECT COUNT(*) AS issued FROM tickets t WHERE t.order_id = o.id AND t.status <> 'cancelled'
) t
WHERE t.issued <> CASE WHEN o.status IN ('paid', 'delivered') THEN o.quantity ELSE 0 END

UNION ALL
SELECT 'ticket_identity', o.event_id, format('ticket=%s order=%s', t.id, o.id)
FROM tickets t
JOIN orders o ON o.id = t.order_id
WHERE t.user_id <> o.user_id OR t.event_id <> o.event_id

UNION ALL
SELECT 'result_target', a.event_id, format('admission=%s operation=%s', a.admission_id, a.operation)
FROM admission_results a
LEFT JOIN reservations r ON r.id = a.reservation_id
LEFT JOIN orders o ON o.id = a.order_id
WHERE a.outcome = 'consumed' AND NOT COALESCE(
  (a.operation = 'reservation' AND r.user_id = a.user_id AND r.event_id = a.event_id
    AND r.tier_id = a.fingerprint::jsonb ->> 4 AND r.quantity = (a.fingerprint::jsonb ->> 5)::int)
  OR (a.operation = 'direct-checkout' AND o.user_id = a.user_id AND o.event_id = a.event_id
    AND o.reservation_id IS NULL AND o.tier_id = a.fingerprint::jsonb ->> 4
    AND o.quantity = (a.fingerprint::jsonb ->> 5)::int
    AND o.idempotency_key::text = a.fingerprint::jsonb ->> 6), false)

UNION ALL
SELECT 'result_fingerprint', a.event_id, format('admission=%s', a.admission_id)
FROM admission_results a
WHERE a.fingerprint::jsonb ->> 0 IS DISTINCT FROM a.user_id::text
  OR a.fingerprint::jsonb ->> 1 IS DISTINCT FROM a.event_id::text
  OR a.fingerprint::jsonb ->> 2 IS DISTINCT FROM a.epoch::text
  OR a.fingerprint::jsonb ->> 3 IS DISTINCT FROM a.operation

UNION ALL
SELECT 'unlinked_occupation', r.event_id, format('reservation=%s', r.id)
FROM reservations r
JOIN admission_events p ON p.event_id = r.event_id AND p.protected
WHERE NOT EXISTS (
  SELECT 1 FROM admission_results a WHERE a.reservation_id = r.id AND a.outcome = 'consumed')

UNION ALL
SELECT 'unlinked_occupation', o.event_id, format('order=%s', o.id)
FROM orders o
JOIN admission_events p ON p.event_id = o.event_id AND p.protected
WHERE o.reservation_id IS NULL AND NOT EXISTS (
  SELECT 1 FROM admission_results a WHERE a.order_id = o.id AND a.outcome = 'consumed')

UNION ALL
SELECT 'payment_settled', o.event_id,
  format('order=%s status=%s settled=%s', o.id, o.status, p.settled)
FROM orders o
CROSS JOIN LATERAL (
  SELECT COUNT(*) AS settled FROM payment_records p
  WHERE p.order_id = o.id AND p.status = 'settled' AND NOT p.reconciliation_required
) p
WHERE p.settled <> CASE WHEN o.status IN ('paid', 'delivered') THEN 1 ELSE 0 END

UNION ALL
SELECT 'payment_callback_key', o.event_id, format('payment_record=%s order=%s', p.id, o.id)
FROM payment_records p
JOIN orders o ON o.id = p.order_id
WHERE p.provider_transaction_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM payment_callback_keys k
  WHERE k.idempotency_key = p.idempotency_key AND k.order_id = p.order_id
    AND k.provider_transaction_id = p.provider_transaction_id)

UNION ALL
SELECT 'payment_checkout_record', o.event_id, format('order=%s records=%s', o.id, p.records)
FROM orders o
CROSS JOIN LATERAL (
  SELECT COUNT(*) AS records FROM payment_records p
  WHERE p.order_id = o.id AND p.provider_transaction_id IS NULL
    AND lower(p.idempotency_key) = o.idempotency_key::text
) p
WHERE p.records <> 1
