# Redis 전략

PeakPass에서 Redis는 성능과 운영 편의성을 높이기 위한 보조 계층이다.  
정합성 기준은 PostgreSQL이며, Redis를 잃어도 DB 기준으로 복구 가능한 구조를 유지한다.

## 사용 목적

현재 코드 기준 Redis 사용 영역은 다음과 같다.

1. 예약 hold TTL 관리
2. rate limiting
3. 멱등성 결과 cache
4. 이벤트 조회 cache와 재고 cache

관련 코드는 [commands.ts](../src/infra/redis/commands.ts)에 모여 있다.

## 1. 예약 hold TTL

- 키 예시: `reservation:{reservationId}`
- 저장 시점: 예약 DB commit 이후
- 삭제 시점: 예약 release 또는 convert의 DB commit 이후
- 목적: 빠른 조회와 만료 시각 관리

중요한 점:

- Redis hold만 믿지 않음
- Redis miss면 DB에서 `status`, `expires_at`를 다시 확인함
- checkout 성공 후 reservation hold를 즉시 삭제해 stale active 상태를 줄임

현재 checkout 경로는 reservation을 `UPDATE ... WHERE status='active' AND expires_at > NOW() RETURNING`의 단일 atomic 쿼리로 검증·전환하므로 Redis hold를 *읽지 않는다*. Redis hold의 read 경로는 단 한 곳, `GET /reservations/:id`(`ReservationService.getReservationWithClient`)뿐이다. 목적은 GET 응답 가속과 클라이언트가 만료 시각(`expiresAt`)을 빠르게 표시하기 위한 것이며, hold가 stale해도 정합성에는 영향이 없다 (정합성 판단은 모두 DB 트랜잭션 안에서). Redis 장애 시 DB fallback이 자동으로 동작한다.

## 2. rate limiting

- 대상: `reservation`, `checkout`, `settlement webhook`
- 기준: 인증 사용자 ID 우선, 없으면 IP fallback
- 구현 방식: Redis sorted set 기반 sliding window

관련 흐름은 [rateLimit.ts](../src/api/middleware/rateLimit.ts)와 [app.ts](../src/api/app.ts)에서 연결한다.

### Redis 장애 시 동작 (RATE_LIMIT_FAIL_MODE)

| 모드 | 동작 | 권장 사용 |
|---|---|---|
| `closed` (default) | 503 RATE_LIMIT_UNAVAILABLE 반환 | 운영 환경. checkout/reservation/webhook 모두 자원 점유와 결제로 이어지는 고위험 경로이므로 폭주가 leak되는 위험이 단순 503보다 크다 |
| `open` | 요청 통과 (warn 로그만 남김) | 비핵심 read 경로 또는 가용성을 우선해야 하는 환경 |

기본값을 `closed`로 둔 이유: rate limit이 결제 경로의 폭주 방어 1차 layer이므로, Redis 장애 시 그 layer가 사라진 상태로 트래픽을 받는 것은 oversell·결제 중복 위험을 키운다. 503으로 *명시적으로* 거절하고 클라이언트가 backoff 하도록 만드는 쪽이 안전하다.

## 3. 멱등성 결과 cache

- 키 예시: `idempotency:{key}`
- 저장 시점: checkout 또는 settlement webhook 성공 응답 이후
- 목적: 동일 요청 재시도 시 빠른 응답 재사용
- 주의: DB unique constraint가 1차 방어선이고, Redis는 2차 보조 계층이다

### 멱등성 lock과 fencing token

처리 중인 요청을 표시하기 위해 별도의 `idempotency:lock:{key}`를 사용한다. lock 획득 시 `randomUUID()`로 발급한 owner token을 value로 저장하고, 해제 시 Lua script로 `GET == token` 확인 후에만 `DEL`한다. TTL 만료 후 다른 요청이 같은 key의 lock을 잡은 상태에서 원래 요청이 release를 호출해도 token mismatch로 no-op이 되어 lock 분실 사고를 막는다.

## 4. 조회 cache

- 이벤트 목록
- 이벤트 상세
- 이벤트 재고

무효화 시점:

- 이벤트 생성 후 목록 cache 무효화
- checkout 성공 후 이벤트 상세와 재고 cache 무효화
- settlement webhook은 주문 상태를 바꾸지만 이벤트 재고 수량은 checkout에서 이미 반영했으므로 주로 주문/티켓 조회 쪽이 영향을 받음

## TTL 값

현재 기본 TTL은 다음과 같다.

- 예약 hold: 300초
- 이벤트 cache: 600초
- 재고 cache: 60초
- 멱등성 결과: 86400초
- rate limiting window: 60초

## 실패 시 동작 원칙

- Redis 읽기 실패는 경고 로그와 함께 가능한 범위에서 계속 진행
- rate limiting은 `RATE_LIMIT_FAIL_MODE`에 따라 동작 (default `closed` = 503 반환)
- Redis cache 손실은 성능 저하로 이어질 수 있지만 주문 정합성은 깨지지 않음

## 면접 포인트

- Redis를 source of truth로 두지 않음
- TTL hold, rate limiting, idempotency, query cache를 실제 운영 패턴으로 설명 가능
- 모든 Redis 부작용을 DB commit 이후 경계에 맞춰 두려고 했음
- rate limit은 fail-closed가 default. 결제 경로의 폭주 방어 layer를 잃은 상태로 트래픽을 받는 것을 막는다