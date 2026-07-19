-- 006_status_constraints.sql
--
-- 애플리케이션 status 모델(zod enum + 실행 코드가 기록하는 값)과 DB status
-- domain을 CHECK constraint로 정렬한다.
--
-- - 기존 row는 UPDATE/DELETE하지 않는다 (제약 추가만).
-- - constraint가 이미 존재하는 등 schema drift가 있으면 이 migration은
--   조용히 넘어가지 않고 실패한다 (runner의 파일 단위 트랜잭션으로 rollback).
-- - 상태 전이 정책 자체는 변경하지 않는다 — 허용 "값 집합"만 강제한다.

ALTER TABLE events
ADD CONSTRAINT events_status_allowed_check
CHECK (status IN ('draft', 'published', 'closed', 'cancelled'));

ALTER TABLE reservations
ADD CONSTRAINT reservations_status_allowed_check
CHECK (status IN ('active', 'released', 'converted', 'expired'));

ALTER TABLE orders
ADD CONSTRAINT orders_status_allowed_check
CHECK (status IN ('pending', 'paid', 'delivered', 'cancelled'));

ALTER TABLE tickets
ADD CONSTRAINT tickets_status_allowed_check
CHECK (status IN ('active', 'used', 'cancelled'));

ALTER TABLE payment_records
ADD CONSTRAINT payment_records_status_allowed_check
CHECK (status IN ('pending', 'settled', 'failed'));
