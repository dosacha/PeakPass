# 면접 연습 4단계

이 문서는 PeakPass를 면접 자리에서 말로 설명하기 위한 연습 스크립트다. 각 단계는 예상 질문, 30초 답변, 2분 답변, 근거 파일, 꼬리 질문으로 구성한다.

## 1단계: GraphQL read-side 설명

### 예상 질문

이 프로젝트에서 GraphQL을 read-side에만 둔 이유는 무엇인가.

### 30초 답변

PeakPass는 상태를 바꾸는 흐름은 REST로 두고, 화면 조합이 많은 조회만 GraphQL로 분리했습니다. 예약, 체크아웃, settlement webhook은 멱등성 키와 트랜잭션 경계가 중요해서 `POST /reservations`, `POST /checkouts`, `POST /webhooks/payments/settlement`처럼 REST가 더 명확합니다. 반대로 이벤트 상세, 내 주문, 내 티켓 같은 조회는 필요한 필드 조합이 달라지기 쉬워 GraphQL이 잘 맞습니다.

### 2분 답변

GraphQL을 전면 도입하지 않은 이유는 쓰기 흐름의 경계를 흐리지 않기 위해서입니다. PeakPass에서 write-side는 좌석 차감, 주문 생성, 결제 확정, 티켓 발급처럼 부작용이 큰 작업입니다. 이 흐름은 HTTP 상태 코드, `Idempotency-Key`, rate limit, PostgreSQL transaction 경계를 명시하기 쉬운 REST로 유지했습니다.

GraphQL은 read-side에 집중했습니다. 현재 스키마는 `events`, `event`, `myOrders`, `myTickets`, `ticketByCode`를 제공하고, resolver는 실제 DB 조회와 DataLoader로 연결되어 있습니다. `myOrders`와 `myTickets`는 인증된 `context.userId`가 없으면 `UNAUTHENTICATED` 오류를 반환합니다.

또한 query complexity 제한이 Apollo plugin의 `didResolveOperation` 단계에 연결되어 있습니다. `createComplexityPlugin({ max: config.GRAPHQL_MAX_COMPLEXITY })`가 resolver 진입 전에 query cost를 계산하고, 기본 한도 5000을 넘으면 DB 접근 전에 거부합니다.

### 근거 파일

- `src/api/graphql/types.ts`
- `src/api/graphql/resolvers.ts`
- `src/api/graphql/loaders.ts`
- `src/api/graphql/server.ts`
- `src/api/graphql/complexity.ts`
- `src/tests/unit/graphql-complexity.test.ts`
- `docs/GRAPHQL_RATIONALE.md`

### 꼬리 질문

- 왜 GraphQL mutation을 쓰지 않았는가
- query complexity는 어느 단계에서 막는가
- `myOrders`와 `myTickets`는 실제 DB와 연결되어 있는가

## 2단계: reservation hold와 Redis 설명

### 예상 질문

예약 hold를 Redis와 DB 중 어디에 두었는가.

### 30초 답변

정합성 기준은 PostgreSQL이고 Redis는 보조 계층입니다. reservation 생성 시 `events` 행을 `FOR UPDATE`로 잠그고 `available_seats`를 먼저 차감한 뒤 `reservations` 행을 `active`로 저장합니다. DB commit 이후에만 Redis TTL hold를 저장합니다. Redis는 빠른 조회와 TTL 관리에 쓰지만, source of truth는 아닙니다.

### 2분 답변

`ReservationService.createReservationWithClient()`는 이벤트 행을 `SELECT available_seats FROM events WHERE id = $1 FOR UPDATE`로 잠급니다. 좌석이 부족하면 실패하고, 충분하면 같은 트랜잭션 안에서 `available_seats`를 차감한 뒤 `reservations` 행을 `active` 상태로 저장합니다.

DB commit이 끝난 뒤 `setReservationHold()`가 `reservation:{reservationId}` 키에 TTL 300초로 hold 정보를 저장합니다. 조회 시 Redis에 값이 있으면 빠르게 반환하고, 없으면 DB의 `status`, `expires_at`를 기준으로 다시 판단합니다. release와 expire는 reservation 행을 `FOR UPDATE`로 잠근 뒤 active 상태에서만 좌석을 원복하고, convert는 좌석을 원복하지 않고 order 점유로 이전합니다.

이 구조는 Redis 장애나 cache miss가 생겨도 DB 기준 정합성을 유지합니다. Redis는 속도와 운영 편의성을 주지만, 좌석 수를 최종 판단하는 저장소가 아닙니다.

### 근거 파일

- `src/core/services/reservation.service.ts`
- `src/infra/redis/commands.ts`
- `src/infra/migrations/001_init_schema.sql`
- `docs/REDIS_STRATEGY.md`

### 꼬리 질문

- Redis hold가 사라지면 예약은 무조건 invalid인가
- 만료된 reservation의 좌석은 어디서 원복되는가
- reservation을 checkout에 쓰면 좌석을 다시 차감하는가

## 3단계: checkout과 settlement 정합성 설명

### 예상 질문

동시에 여러 명이 같은 좌석을 사려고 하면 어떻게 oversell을 막는가.

### 30초 답변

`POST /checkouts`는 `serializableTransactionWithRetry()` 안에서 실행되고, 이벤트 행을 `FOR UPDATE`로 잠급니다. reservation을 사용한 checkout은 reservation 단계에서 이미 좌석을 차감했으므로 추가 차감하지 않고, active이면서 만료되지 않은 reservation만 atomic `UPDATE ... RETURNING`으로 `converted` 처리합니다. 직접 checkout은 이벤트 재고를 잠근 뒤 같은 트랜잭션 안에서 주문 생성과 좌석 차감을 처리합니다.

### 2분 답변

checkout 진입 전에는 idempotency middleware가 `Idempotency-Key`를 확인하고 Redis lock과 결과 cache를 사용합니다. 서비스 내부에서도 `orders.idempotency_key`로 기존 주문을 조회하므로 Redis가 없어도 DB unique constraint가 최종 방어선입니다.

reservation checkout은 먼저 `UPDATE reservations SET status = 'converted' WHERE id = $1 AND status = 'active' AND expires_at > NOW() RETURNING id`를 실행합니다. 이 쿼리는 상태 확인과 전환을 한 번에 처리하므로 valid 체크와 convert 사이의 race condition을 줄입니다. 실패하면 lazy expire를 호출하고 충돌 오류를 반환합니다. reservation 단계에서 좌석이 이미 차감되었기 때문에 checkout에서는 좌석을 추가 차감하지 않습니다.

reservation 없이 들어온 직접 checkout은 `events` 행을 `FOR UPDATE`로 잠그고 재고를 확인한 뒤 `orders`를 `pending`으로 만들고 `events.available_seats`를 차감합니다. checkout 시점에는 티켓을 발급하지 않고 `payment_records`를 `pending`으로 남깁니다.

티켓 발급은 settlement webhook에서만 일어납니다. `processPaymentWebhook()`은 주문을 `FOR UPDATE`로 잠그고, `settled`이면 payment record를 기록한 뒤 주문을 `paid`로 바꾸고 기존 티켓이 없을 때만 `ticket_number_seq`로 티켓을 발급합니다. 이미 paid 상태이거나 티켓이 있으면 duplicate로 보고 기존 결과를 반환합니다. `failed` webhook은 payment record를 `failed`로 기록하고 이벤트 행을 잠근 뒤 좌석을 원복하고 주문을 `cancelled`로 바꿉니다.

### 근거 파일

- `src/api/rest/checkouts.ts`
- `src/api/rest/payments.ts`
- `src/core/services/checkout.service.ts`
- `src/infra/postgres/client.ts`
- `src/api/middleware/idempotency.ts`
- `src/api/middleware/webhook-signature.ts`
- `src/infra/migrations/001_init_schema.sql`
- `src/infra/migrations/002_ticket_number_sequence.sql`
- `src/infra/migrations/003_payment_provider_transaction_unique.sql`

### 꼬리 질문

- checkout 직후 티켓을 발급하지 않는 이유는 무엇인가
- 같은 settlement webhook이 두 번 오면 어떤 경로로 중복 발급을 막는가
- Redis idempotency lock이 실패하면 정합성이 깨지는가

## 4단계: 운영 준비와 검증 설명

### 예상 질문

이 프로젝트를 실제 운영에 가깝게 만들기 위해 무엇을 챙겼는가.

### 30초 답변

Fastify 앱 부팅과 종료 흐름, `/health`, `/ready`, request id, Pino 기반 구조화 로그, graceful shutdown을 넣었습니다. webhook은 raw body를 보존해 `X-Webhook-Signature`와 `X-Webhook-Timestamp` 기반 HMAC 검증을 수행하고, production에서는 `WEBHOOK_SIGNING_SECRET`이 없으면 시작하지 않도록 했습니다. Docker Compose 로컬 실행과 Terraform 기반 AWS 구조도 문서화했습니다.

### 2분 답변

`src/main.ts`는 설정 로딩, 로거 초기화, PostgreSQL pool 초기화, Redis 초기화, Fastify 앱 생성, 서버 listen 순서로 부팅합니다. 종료 시에는 HTTP 서버, PostgreSQL pool, Redis 연결을 순서대로 닫습니다.

`src/api/app.ts`는 JSON parser를 직접 등록해 raw body Buffer를 보존합니다. 이 raw body가 webhook HMAC 검증에 쓰입니다. 그 다음 request id, webhook signature, JWT auth, rate limit, idempotency middleware를 연결하고 REST route와 GraphQL route를 등록합니다.

운영 관점에서는 `/health`와 `/ready`를 분리했습니다. `/health`는 프로세스 생존 확인이고, `/ready`는 PostgreSQL과 Redis 연결 상태까지 확인합니다. 부하 테스트는 k6로 baseline, spike, sustained reservation, rate-limit 비교 시나리오를 두었고, commit된 결과 파일은 `load-test/results/`에 있습니다.

### 근거 파일

- `src/main.ts`
- `src/api/app.ts`
- `src/api/health.ts`
- `src/infra/config.ts`
- `src/infra/logger.ts`
- `docs/PRODUCTION_HARDENING.md`
- `docs/LOAD_TEST_STRATEGY.md`
- `docs/PERFORMANCE_REPORT.md`
- `docs/DEPLOYMENT_RUNBOOK.md`

### 꼬리 질문

- `/health`와 `/ready`를 나눈 이유는 무엇인가
- webhook signature 검증은 왜 raw body가 필요한가
- Docker Compose와 Terraform은 각각 어떤 역할인가

## 연습 순서

1. 각 단계의 30초 답변만 먼저 말한다.
2. 같은 질문에 대해 2분 답변으로 확장한다.
3. 답변 뒤 근거 파일을 열어 실제 코드와 연결한다.
4. 꼬리 질문을 받아 핵심 문장을 다시 정리한다.

마지막에 자연스럽게 남길 문장:

- PeakPass는 PostgreSQL을 source of truth로 두고 좌석, 주문, 결제, 티켓 발급의 정합성을 지키는 프로젝트입니다.
- Redis는 hold TTL, rate limit, idempotency, cache를 맡지만 최종 정합성 기준은 아닙니다.
- write-side는 REST, read-side는 GraphQL로 나누었습니다.
- checkout은 트랜잭션과 행 잠금으로 oversell을 막고, 티켓은 settlement 이후에만 발급합니다.