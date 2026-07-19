# Redis 전략

PeakPass에서 Redis는 성능과 편의성을 높이기 위한 보조 계층입니다.
정합성 기준은 PostgreSQL이며, Redis를 잃어도 DB 기준으로 복구 가능한 구조를 유지합니다.

## 사용 목적

현재 코드 기준 Redis 사용 영역은 다음과 같습니다.

1. 예약 hold TTL 관리 (조회 가속)
2. rate limiting
3. command별 멱등성 결과 cache와 in-flight lock

관련 코드는 [commands.ts](../src/infra/redis/commands.ts)에 모여 있습니다.

## 1. 예약 hold TTL

- 키 예시: `reservation:{reservationId}`
- 저장 시점: 예약 DB commit 이후
- 삭제 시점: checkout convert 또는 만료(expire) 처리의 DB commit 이후
- 목적: 빠른 조회와 만료 시각 표시
- 주의: **Redis TTL 만료 자체는 DB 좌석을 복구하지 않는다.** 만료 예약의 좌석
  복구는 background sweeper(5분 주기)와 checkout 경로의 lazy expiration이
  DB 트랜잭션 안에서 수행한다.

중요한 점은 다음과 같습니다.

- Redis hold만 믿지 않음
- Redis miss면 DB에서 `status`, `expires_at`를 다시 확인함
- checkout 성공 후 reservation hold를 즉시 삭제해 stale active 상태를 줄임

현재 checkout 경로는 reservation을 `UPDATE ... WHERE status='active' AND expires_at > NOW() RETURNING`의 단일 atomic 쿼리로 검증·전환하므로 Redis hold를 *읽지 않습니다*. Redis hold의 read 경로는 단 한 곳, `GET /reservations/:id`(`ReservationService.getReservationWithClient`)뿐입니다. 목적은 GET 응답 가속과 클라이언트가 만료 시각(`expiresAt`)을 빠르게 표시하기 위한 것이며, hold가 stale해도 정합성에는 영향이 없습니다(정합성 판단은 모두 DB 트랜잭션 안에서 수행됨). Redis 장애 시 DB fallback이 자동으로 동작합니다.

## 2. rate limiting

- 대상: `reservation`, `checkout`, `settlement webhook`
- 기준: 인증 사용자 ID 우선, 없으면 IP fallback
- 구현 방식: Redis sorted set 기반 sliding window

관련 흐름은 [rateLimit.ts](../src/api/middleware/rateLimit.ts)와 [app.ts](../src/api/app.ts)에서 연결합니다.

### Redis 장애 시 동작 (RATE_LIMIT_FAIL_MODE)

| 모드 | 동작 | 권장 사용 |
|---|---|---|
| `closed` (default) | 503 RATE_LIMIT_UNAVAILABLE 반환 | 실서비스 환경. checkout / reservation / webhook 모두 자원 점유와 결제로 이어지는 고위험 경로이므로 폭주가 leak되는 위험이 단순 503보다 큼 |
| `open` | 요청 통과 (warn 로그만 남김) | 비핵심 read 경로 또는 가용성을 우선해야 하는 환경 |

기본값을 `closed`로 둔 이유는 다음과 같습니다. rate limit이 결제 경로의 폭주 방어 1차 layer이므로, Redis 장애 시 그 layer가 사라진 상태로 트래픽을 받는 것은 oversell·결제 중복 위험을 키웁니다. 503으로 *명시적으로* 거절하고 클라이언트가 backoff 하도록 만드는 쪽이 안전합니다.

## 3. 멱등성 결과 cache

- 키 예시: `idempotency:{scope}:{key}` — scope는 `checkout` 또는 `payment-settlement`
- 저장 시점: checkout 또는 settlement webhook 성공 응답 이후
- 목적: 동일 요청 재시도 시 빠른 응답 재사용
- scope를 두는 이유: 두 command가 같은 middleware를 공유하고 응답 shape가
  다르므로, 같은 raw `Idempotency-Key`가 command 경계를 넘어 재생되면 안 된다
- 주의: DB 제약(`orders.idempotency_key` UNIQUE, `payment_records`의
  record 종류별 partial UNIQUE)이 최종 방어선이고, Redis는 보조 계층임

### 멱등성 lock과 fencing token

처리 중인 요청을 표시하기 위해 별도의 `idempotency:lock:{scope}:{key}`를 사용합니다. lock 획득 시 `randomUUID()`로 발급한 owner token을 value로 저장하고, 해제 시 Lua script로 `GET == token` 확인 후에만 `DEL`합니다. TTL 만료 후 다른 요청이 같은 key의 lock을 잡은 상태에서 원래 요청이 release를 호출해도 token mismatch로 no-op이 되어 lock 분실 사고를 막습니다. lock 역시 scope별로 분리되어, 한 command의 in-flight lock이 다른 command를 막지 않습니다.

## 이벤트/재고 read-through cache는 미구현

이벤트 목록·상세·재고에 대한 read-through cache는 **현재 구현되어 있지 않습니다.**
조회는 항상 PostgreSQL로 직행하며, GraphQL은 요청 스코프의 DataLoader batching만
사용합니다(요청 간 캐시 아님).

코드에는 checkout/settlement 성공 후 이벤트 관련 캐시 키를 방어적으로 삭제하는
`invalidateEventCache` 호출과 예약된 TTL 상수가 남아 있지만, 해당 키를 채우는
write 경로가 없으므로 이는 향후 캐시 도입을 대비한 무효화 hook일 뿐입니다.
캐시가 burst read로부터 DB를 보호한다는 주장은 하지 않습니다.

## TTL 값

현재 기본 TTL은 다음과 같습니다.

- 예약 hold: 300초
- 멱등성 결과: 86400초
- 멱등성 in-flight lock: 30초
- rate limiting window: 60초

(코드의 `EVENT_CACHE`/`INVENTORY_COUNT` TTL 상수는 미구현 read-through cache용으로
예약된 값이며 현재 런타임에서 사용되지 않습니다.)

## 실패 시 동작 원칙

- Redis 읽기 실패는 경고 로그와 함께 가능한 범위에서 계속 진행
- rate limiting은 `RATE_LIMIT_FAIL_MODE`에 따라 동작 (default `closed` = 503 반환)
- Redis cache 손실은 성능 저하로 이어질 수 있지만 주문 정합성은 깨지지 않음

## 설계 원칙 요약

- Redis를 source of truth로 두지 않음
- TTL hold, rate limiting, command별 idempotency cache/lock을 실제 사용 패턴으로 설명 가능
- 모든 Redis 부작용을 DB commit 이후 경계에 맞춰 두려고 했음
- rate limit은 fail-closed가 default. 결제 경로의 폭주 방어 layer를 잃은 상태로 트래픽을 받는 것을 막음