# 트랜잭션과 정합성

이 문서는 PeakPass에서 가장 중요한 정합성 규칙과 이를 코드에서 어떻게 지키는지 정리합니다.

## 핵심 불변식

- `available_seats`는 절대 0 아래로 내려가면 안 됨
- 같은 `idempotency_key`로 중복 주문이 생성되면 안 됨
- 같은 settlement webhook이 다시 와도 티켓이 중복 발급되면 안 됨
- 같은 예약 hold가 만료되었거나 이미 전환된 뒤 다시 유효하다고 판단되면 안 됨
- Redis 장애가 발생해도 PostgreSQL 정합성이 기준이어야 함

## 정합성 기준

- 최종 기준 저장소: PostgreSQL
- 보조 계층: Redis
- Redis 역할: 조회 가속, TTL hold, 레이트 리미트, 멱등성 응답 캐시

## 체크아웃 흐름

핵심 코드는 [checkout.service.ts](../src/core/services/checkout.service.ts)와 [checkouts.ts](../src/api/rest/checkouts.ts)에 있습니다.

### 1. 멱등성 선검사

- `Idempotency-Key`는 헤더 기준으로 정규화
- 서비스 내부에서 `orders.idempotency_key`로 기존 주문 조회
- 이미 처리된 키면 기존 주문 반환

### 2. 예약 atomic 전환

- `reservationId`가 있으면 checkout 트랜잭션 안에서 `UPDATE reservations ... RETURNING` 수행
- 조건은 `status = 'active'`, `expires_at > NOW()`, user/event/tier/quantity 일치까지 한 번에 검증
- 이 한 쿼리가 row lock, 유효성 검증, `converted` 전환을 함께 처리
- affected row가 0이면 존재 여부, 만료, 상태, payload mismatch를 분리해 404 / 409 반환
- checkout 경로는 Redis hold를 읽지 않음. Redis hold는 정합성 layer가 아니라 read-side / UX 보조 계층

### 3. 이벤트 행 잠금

```sql
SELECT ...
FROM events
WHERE id = $1
FOR UPDATE
```

- 같은 이벤트 재고에 대한 동시 차감을 직렬화
- 재고 확인과 차감을 같은 트랜잭션 안에서 수행

### 4. 주문 생성과 재고 차감

- `orders` INSERT
- reservation이 없으면 `events.available_seats = available_seats - quantity`
- reservation이 있으면 이미 soft hold로 차감된 좌석을 order 점유로 이전
- `payment_records` INSERT with `pending`

### 5. 커밋 이후 외부 부작용

- reservation hold 삭제
- 멱등성 성공 결과 캐시 저장 (checkout scope)
- 이벤트 관련 캐시 키 방어적 삭제 (read-through cache는 현재 미구현 — [REDIS_STRATEGY.md](./REDIS_STRATEGY.md) 참조)

checkout 시점에는 티켓을 발급하지 않습니다.
이 순서가 중요한 이유는, 결제 확정 전 티켓이 먼저 생기는 문제를 막기 위해서입니다.

## settlement webhook 흐름

핵심 코드는 [payments.ts](../src/api/rest/payments.ts)와 [payment-webhook.service.ts](../src/core/services/payment-webhook.service.ts)에 있습니다.

### settled webhook

- order를 `FOR UPDATE`로 잠금
- payment record를 `settled`로 기록
- order를 `paid`로 전환
- 기존 티켓이 없을 때만 티켓 발급
- 커밋 이후 캐시 무효화와 멱등성 결과 저장

### failed webhook

- payment record를 `failed`로 기록
- order를 `cancelled`로 전환
- 이벤트 재고를 원복

## duplicate webhook 방어

- webhook 자체도 `Idempotency-Key`를 사용하며, Redis 결과 캐시·lock은
  checkout과 분리된 `payment-settlement` scope namespace를 사용
- 같은 `Idempotency-Key` 재전송은 캐시된 기존 응답을 그대로 재생 (duplicate flag도 원본 값 유지)
- 다른 `Idempotency-Key` + 같은 `providerTransactionId` 재시도는 `duplicate: true`로 수렴
- `payment_records.provider_transaction_id` 고유 인덱스 사용
- order를 `FOR UPDATE`로 잠금
- 이미 `paid` 상태이거나 기존 티켓이 있으면 중복 발급 없이 기존 결과 반환

## 예약 hold 흐름

핵심 코드는 [reservation.service.ts](../src/core/services/reservation.service.ts)에 있습니다.

- 예약 생성은 DB 트랜잭션으로 먼저 저장
- 생성 트랜잭션에서 `events.available_seats`를 즉시 차감해 soft hold를 잡음
- 커밋 이후 `setReservationHold()`로 Redis TTL hold 저장
- Redis hold는 `GET /reservations/:id` 응답 가속과 만료 시각 표시를 위한 보조 캐시
- **Redis TTL 만료 자체는 DB 좌석을 복구하지 않음** — 만료 예약의 좌석 복구는
  background sweeper(5분 주기)와 checkout 경로의 lazy expiration이 수행하며,
  두 경로 모두 `status = 'active'`인 예약만 원복 처리해 이중 복구를 막음
- checkout은 Redis hold를 읽지 않고 DB atomic UPDATE로만 reservation을 검증·전환
- 사용자용 명시적 취소(release) HTTP route는 현재 없음 — release는 서비스 계층
  메서드로만 존재
- 예약 expire / checkout convert는 DB 상태를 먼저 바꾸고 커밋 이후 Redis hold 삭제

## DB 제약과 모델링

실제 제약은 [001_init_schema.sql](../src/infra/migrations/001_init_schema.sql), [002_ticket_number_sequence.sql](../src/infra/migrations/002_ticket_number_sequence.sql), [003_payment_provider_transaction_unique.sql](../src/infra/migrations/003_payment_provider_transaction_unique.sql), [005_payment_record_idempotency_scopes.sql](../src/infra/migrations/005_payment_record_idempotency_scopes.sql), [006_status_constraints.sql](../src/infra/migrations/006_status_constraints.sql), [007_available_seats_ceiling.sql](../src/infra/migrations/007_available_seats_ceiling.sql)에 있습니다.

대표 예시는 다음과 같습니다.

- `events.available_seats >= 0` (하한) / `available_seats <= total_seats` (상한, `events_available_seats_not_above_total_check`)
- `orders.idempotency_key` 고유성
- `payment_records.idempotency_key`는 record 종류별 partial UNIQUE —
  checkout pending(`provider_transaction_id IS NULL`)과
  settlement terminal(`IS NOT NULL`) scope가 분리되어, 서로 다른 command가
  같은 raw key를 써도 충돌하지 않음
- `tickets.ticket_number` 고유성
- `payment_records.provider_transaction_id` 고유 인덱스
- 모든 status 컬럼의 허용 값 집합 CHECK (`*_status_allowed_check`) —
  애플리케이션 zod 모델과 집합 동등성이 테스트로 고정됨
- `ticket_number_seq` 기반 전역 티켓 번호 생성

주의: CHECK 제약은 **허용 값 집합**만 강제합니다. 상태 **전이 순서**(예:
pending→paid)는 DB state machine이 아니라 애플리케이션 트랜잭션과 행 잠금이
책임집니다. seat 상한 역시 재현된 이중 복구 버그의 수정이 아니라, 향후 새 복구
경로를 대비한 defense-in-depth입니다. clean install(001→007)과 순차 upgrade가
격리 DB 테스트로 검증되어 있으며, schema drift가 있으면 migration이 조용히
넘어가지 않고 실패합니다.

## 핵심 정리

- Redis는 빠르지만 source of truth가 아님
- oversell 방지의 핵심은 Redis 락이 아니라 PostgreSQL 트랜잭션과 행 잠금
- 멱등성은 헤더, DB 고유 키, Redis 응답 캐시를 함께 사용
- 티켓은 checkout 직후가 아니라 settlement 이후에만 발급
- duplicate webhook에도 티켓이 늘지 않도록 방어함

## 현재 상태 메모

- checkout과 settlement 핵심 정합성 흐름은 구현되어 있음
- duplicate settlement webhook 방어까지 실제로 확인함
- GraphQL은 read-side 보조 역할이며 트랜잭션 경계와는 분리되어 있음