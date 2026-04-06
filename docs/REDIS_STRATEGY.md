# Redis 전략

PeakPass에서 Redis는 성능과 운영 편의성을 높이기 위한 보조 계층이다.  
정합성 기준은 PostgreSQL이며, Redis를 잃어도 DB 기준으로 복구 가능한 구조를 유지한다.

## 사용 목적

현재 코드 기준 Redis 사용 영역은 다음과 같다.

1. 예약 hold TTL 관리
2. rate limiting
3. 멱등성 결과 cache
4. 이벤트 조회 cache와 재고 cache

관련 코드는 [commands.ts](C:/Users/dosac/projects/PeakPass/src/infra/redis/commands.ts)에 모여 있다.

## 1. 예약 hold TTL

- 키 예시: `reservation:{reservationId}`
- 저장 시점: 예약 DB commit 이후
- 삭제 시점: 예약 release 또는 convert의 DB commit 이후
- 목적: 빠른 조회와 만료 시각 관리

중요한 점:

- Redis hold만 믿지 않음
- Redis miss면 DB에서 `status`, `expires_at`를 다시 확인함
- checkout 성공 후 reservation hold를 즉시 삭제해 stale active 상태를 줄임

## 2. rate limiting

- 대상: `reservation`, `checkout`, `settlement webhook`
- 기준: 인증 사용자 ID 우선, 없으면 IP fallback
- 구현 방식: Redis sorted set 기반 sliding window

관련 흐름은 [rateLimit.ts](C:/Users/dosac/projects/PeakPass/src/api/middleware/rateLimit.ts)와 [app.ts](C:/Users/dosac/projects/PeakPass/src/api/app.ts)에서 연결한다.

## 3. 멱등성 결과 cache

- 키 예시: `idempotency:{key}`
- 저장 시점: checkout 또는 settlement webhook 성공 응답 이후
- 목적: 동일 요청 재시도 시 빠른 응답 재사용
- 주의: DB unique constraint가 1차 방어선이고, Redis는 2차 보조 계층이다

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
- rate limiting 확인 실패는 fail-open
- Redis cache 손실은 성능 저하로 이어질 수 있지만 주문 정합성은 깨지지 않음

## 면접 포인트

- Redis를 source of truth로 두지 않음
- TTL hold, rate limiting, idempotency, query cache를 실제 운영 패턴으로 설명 가능
- 모든 Redis 부작용을 DB commit 이후 경계에 맞춰 두려고 했음
