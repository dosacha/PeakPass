# 트랜잭션과 정합성

이 문서는 PeakPass에서 가장 중요한 정합성 규칙과 이를 코드에서 어떻게 지키는지 정리한다.

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

핵심 코드는 [checkout.service.ts](C:/Users/dosac/projects/PeakPass/src/core/services/checkout.service.ts)와 [checkouts.ts](C:/Users/dosac/projects/PeakPass/src/api/rest/checkouts.ts)에 있다.

### 1. 멱등성 선검사

- `Idempotency-Key`는 헤더 기준으로 정규화
- 서비스 내부에서 `orders.idempotency_key`로 기존 주문 조회
- 이미 처리된 키면 기존 주문 반환

### 2. 예약 유효성 확인

- `reservationId`가 있으면 `ReservationService.isReservationValidWithClient()` 호출
- Redis hold가 남아 있으면 먼저 참조
- Redis에 없으면 DB 상태와 `expires_at` 확인

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
- `events.available_seats = available_seats - quantity`
- `payment_records` INSERT with `pending`
- reservation이 있으면 `converted` 처리

### 5. 커밋 이후 외부 부작용

- 이벤트 캐시 무효화
- reservation hold 삭제
- 멱등성 성공 결과 캐시 저장

checkout 시점에는 티켓을 발급하지 않는다.  
이 순서가 중요한 이유는, 결제 확정 전 티켓이 먼저 생기는 문제를 막기 위해서다.

## settlement webhook 흐름

핵심 코드는 [payments.ts](C:/Users/dosac/projects/PeakPass/src/api/rest/payments.ts)와 [checkout.service.ts](C:/Users/dosac/projects/PeakPass/src/core/services/checkout.service.ts)에 있다.

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

- webhook 자체도 `Idempotency-Key`를 사용
- `payment_records.provider_transaction_id` 고유 인덱스 사용
- order를 `FOR UPDATE`로 잠금
- 이미 `paid` 상태이거나 기존 티켓이 있으면 중복 발급 없이 기존 결과 반환

## 예약 hold 흐름

핵심 코드는 [reservation.service.ts](C:/Users/dosac/projects/PeakPass/src/core/services/reservation.service.ts)에 있다.

- 예약 생성은 DB 트랜잭션으로 먼저 저장
- 커밋 이후 `setReservationHold()`로 Redis TTL hold 저장
- 예약 release / convert는 DB 상태를 먼저 바꾸고 커밋 이후 Redis hold 삭제

## DB 제약과 모델링

실제 제약은 [001_init_schema.sql](C:/Users/dosac/projects/PeakPass/src/infra/migrations/001_init_schema.sql), [002_ticket_number_sequence.sql](C:/Users/dosac/projects/PeakPass/src/infra/migrations/002_ticket_number_sequence.sql), [003_payment_provider_transaction_unique.sql](C:/Users/dosac/projects/PeakPass/src/infra/migrations/003_payment_provider_transaction_unique.sql)에 있다.

대표 예시:

- `events.available_seats >= 0`
- `orders.idempotency_key` 고유성
- `tickets.ticket_number` 고유성
- `payment_records.provider_transaction_id` 고유 인덱스
- `ticket_number_seq` 기반 전역 티켓 번호 생성

## 면접에서 설명할 포인트

- Redis는 빠르지만 source of truth가 아님
- oversell 방지의 핵심은 Redis 락이 아니라 PostgreSQL 트랜잭션과 행 잠금
- 멱등성은 헤더, DB 고유 키, Redis 응답 캐시를 함께 사용
- 티켓은 checkout 직후가 아니라 settlement 이후에만 발급
- duplicate webhook에도 티켓이 늘지 않도록 방어함

## 현재 상태 메모

- checkout과 settlement 핵심 정합성 흐름은 구현되어 있음
- duplicate settlement webhook 방어까지 실제로 확인함
- GraphQL은 read-side 보조 역할이며 트랜잭션 경계와는 분리되어 있음
