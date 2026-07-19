-- 007_available_seats_ceiling.sql
--
-- available_seats가 물리적 총량(total_seats)을 초과한 상태로 저장되지 못하도록
-- 상한 CHECK를 추가한다.
--
-- - 기존 좌석 차감·복구 로직(InventoryService.adjustAvailableSeats)은 변경하지 않는다.
-- - 기존 row는 UPDATE/DELETE하지 않는다 (제약 추가만).
-- - 실제로 재현된 이중 복구 결함의 수정이 아니라, 향후 새 복구·조정 경로가
--   추가돼도 총량 초과 상태가 저장되지 않도록 하는 DB defense-in-depth다.
-- - 기존 하한(available_seats >= 0)과 total_seats > 0 CHECK는 그대로 유지된다.
--   동명 constraint가 선재하는 등 schema drift가 있으면 조용히 넘어가지 않고
--   실패한다 (runner의 파일 단위 트랜잭션으로 rollback).

ALTER TABLE events
ADD CONSTRAINT events_available_seats_not_above_total_check
CHECK (available_seats <= total_seats);
