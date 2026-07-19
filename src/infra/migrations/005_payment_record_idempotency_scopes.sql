-- 005_payment_record_idempotency_scopes.sql
--
-- payment_records.idempotency_key의 전역 UNIQUE를 record 종류별 partial UNIQUE로 분리한다.
--
-- 배경:
--   checkout은 pending record(provider_transaction_id IS NULL)에 checkout의 raw
--   Idempotency-Key를, settlement webhook은 terminal record(provider_transaction_id
--   IS NOT NULL)에 webhook의 raw Idempotency-Key를 같은 컬럼에 저장한다.
--   서로 다른 command가 같은 raw key를 쓰면 Redis scope를 분리해도 이 전역
--   UNIQUE에서 23505가 발생한다. record 종류는 provider_transaction_id의 NULL
--   여부로 이미 결정적으로 구분되므로, scope column이나 저장값 prefix 없이
--   uniqueness 범위만 둘로 나눈다.
--
-- 안전성:
--   기존 전역 UNIQUE가 모든 key를 유일하게 유지해 왔으므로 각 partial 범위
--   내부에 선재 duplicate는 존재할 수 없다. 기존 row는 UPDATE/DELETE하지 않는다.
--   (runner가 migration 파일 단위 트랜잭션으로 실행하므로 DROP과 CREATE는
--   원자적으로 함께 적용된다)

ALTER TABLE payment_records
DROP CONSTRAINT payment_records_idempotency_key_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_records_checkout_idempotency_key
ON payment_records (idempotency_key)
WHERE provider_transaction_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_records_settlement_idempotency_key
ON payment_records (idempotency_key)
WHERE provider_transaction_id IS NOT NULL;
