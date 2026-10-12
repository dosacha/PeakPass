# PeakPass

> 짧은 시간에 구매자가 몰리는 이벤트의 티켓 예약·결제 백엔드

워크숍, 세미나, 컨퍼런스처럼 판매가 열리는 순간 구매자가 몰리는 이벤트에서는 두 가지 사고가 자주 납니다. 한 자리가 두 명에게 팔리는 초과 판매(oversell)와, 같은 결제 webhook이 두 번 들어와 티켓이 중복 발급되는 일입니다.

PeakPass는 예약, 주문 생성, 결제 정산 webhook이 같은 재고와 주문을 바꾸는 상황에서 PostgreSQL transaction과 제약으로 정합성을 지키고, 구매자가 몰릴 때는 Redis 대기열로 구매 경로에 들어오는 사람 수를 줄이는 백엔드입니다. 재고와 주문의 기준은 항상 PostgreSQL입니다.

공개 데모 서버는 운영하지 않습니다(2026-10-10 기준). 아래 내용은 모두 로컬에서 실행하고 측정한 것입니다.

## 결과

**정합성은 통합 테스트로 고정했습니다.** 실제 PostgreSQL과 Redis를 쓰고 CI에서 돕니다.

- 3석에 서로 다른 5명이 동시에 구매해도 3석만 팔립니다(`src/tests/integration/concurrency.test.ts`).
- 같은 결제의 정산 webhook 5건이 서로 다른 Idempotency-Key로 동시에 와도 티켓과 정산 기록은 한 번만 만들어집니다(`route-contract.test.ts`의 T04).
- 입장 하나는 예약 또는 주문 하나에만 쓰입니다. PostgreSQL 원장의 PK·UNIQUE·UPDATE 금지 trigger로 강제합니다(migration 013).

**유입 제어는 같은 조건의 부하 비교로 측정했습니다.** 초당 50명이 20초 동안 도착하는 조건(구매자 1,000명, 처음 5초의 250명을 뺀 750명 기준, 3회 중앙값)입니다.

| | 대기열 없음 | 대기열 + 적응형 polling |
| --- | --- | --- |
| 결제 완료 | 16.00% | 100% |
| 구매 시도 실패율 | 61.75% | 0% |
| 도착→결제 완료 시간 중앙값 | 1.1초 (결제한 사람만) | 306.8초 |

대기열은 실패를 대기로 바꿨고 처리량을 늘리지는 않았습니다. 이 표는 아래 조건 위에 서 있습니다.

- 대기열 없는 경로의 실패는 용량 부족이 아니라 SERIALIZABLE transaction이 직렬화 실패로 3회의 시도(재시도 2회)를 다 쓴 500입니다. 격리 수준을 내리거나 시도 횟수를 늘린 경우는 재지 않았습니다.
- 초당 50명은 이 비교의 pilot에서 시험한 세 단계(초당 10·25·50명) 가운데 대기열 없는 경로가 안정적이지 않았던 가장 낮은 단계입니다. 초당 10명에서는 대기열 없이도 전원이 결제했고, 초당 25명은 그 pilot에서는 안정이었지만 앞선 쓰기 기준선에서는 3회 중 2회가 과부하였습니다.
- 대기열 없는 쪽의 부하 발생기는 실패한 요청을 한 번만 다시 보냅니다. 주문까지 만들어지고 정산 webhook만 실패해 미결제로 남은 구매자가 1,000명 중 377–386명입니다.
- 초당 2명이라는 입장량은 측정으로 찾은 값이 아니라 처음 정한 가정입니다.
- 로컬 host 한 대, 앱 인스턴스 1개의 합성 부하이며 운영 성과가 아닙니다.

조건, 전체 표, 해석은 [성능 보고서](docs/PERFORMANCE_REPORT.md)에, 문장마다의 근거는 [RESUME_EVIDENCE.md](docs/RESUME_EVIDENCE.md)에 있습니다.

## 먼저 나올 질문

**대기열 없는 경로는 왜 실패했나.** checkout과 정산은 SERIALIZABLE로 실행합니다. 같은 이벤트 행을 두고 겹친 transaction은 앞선 것이 끝나면 직렬화 실패로 끝나 처음부터 다시 시도하고, 3회 안에 끝내지 못하면 500이 됩니다. 구매자가 몰릴수록 이 실패가 쌓입니다.

**행 잠금이 있는데 SERIALIZABLE까지 쓰는 이유는.** 초과 판매를 막는 것은 이벤트 행의 `FOR UPDATE` 잠금입니다. SERIALIZABLE은 같은 Idempotency-Key의 checkout과 중복 정산이 재시도에서 기존 결과를 보게 하는 데 쓰이고 있습니다. 행 잠금만으로 충분한지, 격리 수준을 내리면 어떻게 되는지는 측정하지 않았습니다. 2026-10-10에 이 실패를 조사한 뒤 바꾸지 않기로 정했습니다. 격리 수준과 재시도 정책이 입장 제어 계약에 고정돼 있어, 바꾸면 장애 검증과 부하 측정을 다시 해야 하기 때문입니다([TRANSACTION_CONSISTENCY.md](docs/TRANSACTION_CONSISTENCY.md), [#27](https://github.com/dosacha/PeakPass/issues/27)).

**왜 초당 2명만 입장시키나. 5분 대기는 DB의 한계인가.** 아닙니다. 초당 2명은 처음 정한 가정이고, 입장량을 올린 후보는 입장한 구매자끼리의 직렬화 실패 때문에 실패율 기준을 넘어 탈락했습니다. 대기 시간은 그 가정에서 나옵니다.

**Redis가 죽으면.** 재고와 주문은 틀리지 않습니다. 대신 대기열이 적용된 이벤트는 신규 구매가 모두 닫히고, 기본 설정에서는 rate limiter도 503으로 답합니다. 대기 순번은 복원되지 않아 다시 등록해야 합니다.

## 구조

상태를 바꾸는 명령은 REST로, 조회 조합은 GraphQL로 나눴습니다. 단일 PostgreSQL 위에서 프로토콜만 나눈 것이고, 별도 read database나 event sourcing을 두는 CQRS는 아닙니다.

| 종류 | 경로 |
| --- | --- |
| 상태 확인 | `GET /health`, `GET /ready` |
| 구매 명령 (REST) | `POST /reservations`, `POST /checkouts`, `POST /webhooks/payments/settlement` |
| 입장 대기열 (REST) | `POST /events/:eventId/admissions`, `GET /events/:eventId/admissions/me`, `DELETE /events/:eventId/admissions/:admissionId` |
| 조회 (GraphQL) | `POST /graphql` — `events`, `event`, `myOrders`, `myTickets`, `ticketByCode` |
| 단건 조회 (REST) | `GET /events`, `GET /events/:id`, `GET /reservations/:id`, `GET /checkouts/:orderId` |
| 기본으로 꺼진 것 | `POST /events`(운영자), `POST /demo/session`, `POST /demo/settlement`(데모) |

- **PostgreSQL이 기준입니다.** 재고 차감, 주문 생성, 정산, 티켓 발급, 예약 상태 전환, 입장 소비 결과는 모두 PostgreSQL transaction 안에서 처리합니다.
- **Redis는 네 가지에 씁니다.** 예약 hold의 조회 가속, rate limit, 멱등성 lock과 정산 webhook의 결과 cache, 입장 대기열의 순서·입장 자격·입장 예산입니다. 앞의 셋은 Redis를 잃어도 정합성이 깨지지 않습니다. 대기열은 다릅니다. 대기열이 적용된 이벤트에서는 Redis가 없으면 판매가 멈춥니다.
- 이벤트·재고에 대한 read-through cache는 없습니다.

## 주요 기능

- **예약 hold.** `POST /reservations`가 좌석을 바로 차감해 잡아 둡니다. 만료 시각은 DB에 있고 Redis TTL은 조회 가속용입니다. 만료된 예약의 좌석은 background sweeper와 checkout 경로가 DB transaction 안에서 되돌립니다.
- **주문 생성.** `POST /checkouts`는 주문을 `pending`으로만 만듭니다. 티켓은 결제가 정산되기 전에는 발급하지 않습니다.
- **정산 webhook.** `POST /webhooks/payments/settlement`가 주문을 `paid`로 바꾸고 이때 처음 티켓을 발급합니다. HMAC 서명과 timestamp를 검증합니다.
- **중복 webhook.** 같은 Idempotency-Key의 재전송은 저장한 응답을 그대로 돌려주고, 다른 key로 온 같은 결제는 주문 행 잠금 뒤 이미 `paid`인 것을 확인해 기존 티켓을 반환합니다.
- **초과 판매 방지.** 이벤트 행을 `FOR UPDATE`로 잠그고 차감하며, `available_seats`는 DB CHECK로 하한과 상한이 함께 강제됩니다. 수량은 이벤트 단위로 지킵니다. tier별 수량은 강제하지 않습니다.
- **Rate limit.** Redis sliding window로 구매 요청(예약·checkout 생성, 정산 webhook)과 GraphQL을 서로 다른 한도로 제한합니다. 어느 한도를 쓸지는 route가 선언합니다. 예약 조회는 예약 생성과, 주문 조회는 checkout 생성과 같은 카운터를 씁니다(알려진 한계). Redis에 닿지 않으면 503이 기본값입니다.
- **입장 제어.** 보호하도록 지정한 이벤트는 구매 전에 대기열을 거칩니다. Redis가 등록 순서대로 초당 정해진 수만 입장시키고, 입장 하나는 PostgreSQL 원장 한 행으로 예약 또는 주문 하나에만 쓰입니다. 대기 화면은 polling으로 상태를 읽고 순번이 먼 사용자는 조회 간격을 늘립니다. 기본으로 꺼져 있고(`ENABLE_ADMISSION=false`) 동시에 보호하는 이벤트는 1개입니다. 설계 선택과 한계는 [ADMISSION_DESIGN_AND_OPERATIONS.md](docs/ADMISSION_DESIGN_AND_OPERATIONS.md)에 있습니다.
- **조회.** GraphQL `myOrders`, `myTickets`는 JWT가 필요합니다. `ticketByCode`는 인증 없이 티켓 번호로 게이트 검증용 정보만 돌려줍니다.

## 핵심 정합성 규칙

- 좌석을 바꾸는 코드는 한 곳이고 항상 이벤트 행 잠금 뒤에 실행됩니다.
- `available_seats`는 DB CHECK로 0 미만과 `total_seats` 초과가 모두 막힙니다.
- checkout, 정산, 입장 필드가 있는 예약은 SERIALIZABLE(최대 3회 시도), 입장 필드가 없는 예약은 READ COMMITTED입니다.
- 같은 Idempotency-Key의 checkout은 PostgreSQL advisory lock과 `orders.idempotency_key` UNIQUE로 주문 하나에 모입니다. Redis lock은 최적화입니다.
- checkout은 주문만 만들고 티켓은 정산 뒤에만 발급합니다.
- 모든 status 컬럼은 애플리케이션 모델과 같은 허용 값 집합을 DB CHECK로 가집니다. 전이 순서는 애플리케이션 transaction이 책임집니다.
- Redis에 쓰는 부작용은 가능한 한 commit 뒤에 반영합니다.

## 디렉터리 구조

```
src/
  api/         Fastify 앱 조립, REST 라우트(구매, 입장 대기열), GraphQL 서버, 미들웨어
  core/        도메인 모델과 서비스(예약, checkout, 정산, 입장 제어와 소비 원장)
  infra/       PostgreSQL, Redis(명령과 대기열 Lua), 설정, 마이그레이션, sweeper와 scheduler
  tests/       단위 테스트와 통합 테스트
frontend/      데모 페이지와 대기 화면의 polling controller (빌드 없는 정적 파일)
load-test/     k6 스크립트, flash-sale 하네스, 저장한 측정 결과
docs/          설계, 정합성, 측정 문서와 작업 기록
```

## 빠른 시작

```bash
npm install
npm run build
npm test
npm run lint
```

로컬 실행:

```bash
docker compose up -d postgres redis
docker compose up -d app
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

| 서비스 | 호스트 포트 | 컨테이너 포트 |
| --- | --- | --- |
| PostgreSQL | `5433` | `5432` |
| Redis | `6380` | `6379` |
| App | `3000` | `3000` |

### 운영 이미지

운영 이미지는 `NODE_ENV=production`으로 뜨고, 시작할 때 설정을 검사합니다. `JWT_SECRET`이 없거나 `WEBHOOK_SIGNING_SECRET`이 없거나 32자 미만이면 시작하지 않습니다. 앱을 시작하기 전에 같은 이미지로 마이그레이션을 실행합니다. 빌드 컨텍스트 밖의 `../production.env`에 DB·Redis 연결 설정과 두 secret을 두세요.

```bash
docker build -t peakpass:latest .
docker run --rm --env-file ../production.env peakpass:latest node dist/infra/migrations/runner.js up
docker run --rm --env-file ../production.env -p 3000:3000 peakpass:latest
```

이미 적용한 마이그레이션은 건너뜁니다. `down`은 구현돼 있지 않습니다. CI는 빈 DB에서 운영 이미지의 001–013 적용, 재실행 시 이력 불변, `/ready`, 서명된 요청을 확인합니다. 같은 검사를 DB·Redis 환경 변수를 준 뒤 직접 돌릴 수 있습니다(이미 마이그레이션한 DB는 거부합니다).

```bash
node .github/scripts/production-image-check.mjs peakpass:latest
```

Docker Desktop에서 호스트의 DB·Redis에 붙일 때는 `IMAGE_DB_HOST=host.docker.internal`, `IMAGE_REDIS_HOST=host.docker.internal`을, Linux에서 호스트 네트워크를 쓸 때는 `IMAGE_NETWORK=host`를 줍니다.

## 데모 시나리오

로컬 Compose는 데모 편의를 위해 `ENFORCE_AUTH_USER_MATCH=false`로 뜨므로 2)·3)은 JWT 없이 동작하고, `WEBHOOK_SIGNING_SECRET`을 두지 않아 4)·5)는 서명 검증을 건너뜁니다. 6)은 로컬에서도 JWT가 필요합니다. production 설정에서는 예약·checkout에 JWT가, 정산 webhook에 HMAC 서명이 필요합니다.

### 1) 이벤트 목록 조회

```bash
curl http://localhost:3000/events
```

### 2) 예약 hold 생성

```bash
curl -X POST http://localhost:3000/reservations \
  -H "Content-Type: application/json" \
  -d '{"eventId":"EVENT_ID","userId":"USER_ID","quantity":1,"tierId":"TIER_ID"}'
```

### 3) checkout

```bash
curl -X POST http://localhost:3000/checkouts \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 22222222-2222-2222-2222-222222222222" \
  -d '{"eventId":"EVENT_ID","userId":"USER_ID","quantity":1,"tierId":"TIER_ID","reservationId":"RESERVATION_ID"}'
```

이 시점의 상태: `order.status = pending`, `tickets = []`

### 4) 정산 webhook (티켓 발급)

```bash
curl -X POST http://localhost:3000/webhooks/payments/settlement \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 33333333-4444-5555-6666-777777777777" \
  -d '{"orderId":"ORDER_ID","providerTransactionId":"txn-settle-001","status":"settled"}'
```

이 시점의 상태: `order.status = paid`, 티켓 발급됨

### 5) 같은 정산 webhook 다시 보내기

같은 `Idempotency-Key`로 다시 보내면 저장된 응답이 그대로 돌아옵니다(`duplicate` 값도 첫 응답과 같습니다). 새 `Idempotency-Key`에 같은 `providerTransactionId`로 보내면 `duplicate: true`로 답합니다. 어느 쪽이든 티켓은 늘지 않습니다.

### 6) GraphQL로 내 주문과 티켓 조회

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer JWT_TOKEN" \
  -d '{"query":"query { myOrders(limit: 10) { id status paymentStatus totalAmount } myTickets(limit: 10) { id ticketNumber status } }"}'
```

### 브라우저 데모 세션

`frontend/`의 데모 페이지는 `POST /demo/session`으로 고정된 seed 사용자 한 명의 짧은 JWT를 받을 수 있습니다. 기본으로 꺼져 있고 `ENABLE_DEMO_SESSION=true`로 명시해야 켜집니다. 사용자는 항상 `DEMO_USER_EMAIL`이며 요청이 사용자·이메일·role을 고를 수 없습니다. 이 JWT는 브라우저 메모리에만 두며 실제 로그인이나 접근 제어를 대신하지 않습니다.

켜져 있으면 `POST /demo/settlement`가 이 JWT와 데모 사용자 소유의 주문 ID를 받아, webhook 서명 secret을 브라우저에 주지 않고 같은 정산 서비스를 실행합니다. 실제 `/webhooks/payments/settlement`는 그대로 HMAC 서명을 요구합니다.

## 테스트

단위 테스트는 DB와 Redis 없이 돕니다.

```bash
npm test
```

통합 테스트는 실제 PostgreSQL 16과 Redis 7이 필요합니다. **연결된 DB의 데이터를 지우므로** 개발용 Compose의 DB(5433)에 붙이지 말고 테스트 전용 인스턴스를 띄우세요. 입장 제어 테스트는 persistence를 끄고 `noeviction`으로 둔 Redis를 요구합니다.

```bash
docker run -d --name peakpass-test-pg -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=peakpass -e POSTGRES_PASSWORD=peakpass -e POSTGRES_DB=peakpass postgres:16-alpine
docker run -d --name peakpass-test-redis -p 127.0.0.1:56379:6379 \
  redis:7-alpine redis-server --save "" --appendonly no --maxmemory-policy noeviction

export DB_HOST=127.0.0.1 DB_PORT=55432 DB_USER=peakpass DB_PASSWORD=peakpass DB_NAME=peakpass
export REDIS_HOST=127.0.0.1 REDIS_PORT=56379
npm run migrate:up
npx jest --runInBand --config jest.integration.cjs
```

- `npm run test:concurrency`, `test:webhook`, `test:routes` 등은 위 전체 실행의 부분집합입니다.
- `npm run test:flash-sale`은 부하 하네스의 계약 검사이고 Docker 없이 돕니다.
- 실제 Redis·PostgreSQL·프로세스 장애를 일으키는 스위트와 직렬화 실패 재현 테스트는 환경 변수로 켜는 opt-in이며 CI에서 돌지 않습니다(`ADMISSION_FAULT_IMAGE`, `ADMISSION_SERIALIZATION_REPRO`, `WAVE3_REDIS_DESTRUCTIVE`, `WAVE4_TEST_IMAGE`).

## 부하 테스트

두 종류가 있습니다.

**flash-sale 하네스.** 서로 다른 구매자가 한 이벤트에 몰리는 쓰기 부하입니다. 실행마다 전용 PostgreSQL·Redis·앱을 띄우고, 대기열 없음 / 대기열 + fixed polling / 대기열 + adaptive polling을 같은 조건에서 비교합니다. "결과"의 표가 이 하네스의 측정입니다. 실행 방법은 [load-test/README.md](load-test/README.md)에 있습니다.

**시나리오별 micro-benchmark** (2026-06). 한 사용자가 한 이벤트를 반복해 두드리는 부하라 같은 행의 잠금 경합과 rate limit 동작을 보는 용도이고, 실서비스의 처리량으로 일반화하지 않습니다.

| 시나리오 | 대상 | 보는 것 |
| --- | --- | --- |
| `baseline` | `/health`, GraphQL `events`, `event` | 일반 조회의 기준선 |
| `spike` | GraphQL `event` | 한 이벤트 상세에 조회가 몰릴 때의 tail latency |
| `sustained` | `POST /reservations` | 예약 부하와 429 비율 |
| `callbacks` | `POST /webhooks/payments/settlement` | 반복되는 정산 webhook의 응답과 지연. 티켓 수는 이 스크립트가 아니라 통합 테스트가 확인합니다 |

k6가 필요합니다(Windows 예: `winget install k6.k6`). 앱을 띄운 뒤 실행합니다.

```bash
docker compose up -d postgres redis
docker compose up -d app

# rate limit을 높여 지연만 볼 때
docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d --force-recreate app
docker compose exec redis redis-cli FLUSHDB
```

```bash
export BASE_URL=http://localhost:3000 LOAD_TEST_USER_ID=USER_ID LOAD_TEST_EVENT_ID=EVENT_ID LOAD_TEST_TIER_ID=TIER_ID

npm run load-test:baseline
npm run load-test:spike
npm run load-test:sustained
npm run load-test:callbacks
npm run load-test:rate-limit:graphql
npm run load-test:rate-limit:reservations
```

`:report`를 붙인 스크립트(`npm run load-test:baseline:report` 등)는 결과를 `load-test/results/`에 저장합니다.

## 문서

[docs/README.md](docs/README.md)에 읽는 순서가 있습니다. 먼저 볼 문서는 다음과 같습니다.

1. [ARCHITECTURE_DIAGRAMS.md](docs/ARCHITECTURE_DIAGRAMS.md) — 요청이 흐르는 경로
2. [TRANSACTION_CONSISTENCY.md](docs/TRANSACTION_CONSISTENCY.md) — 초과 판매와 중복 발급을 막는 방법
3. [ADMISSION_DESIGN_AND_OPERATIONS.md](docs/ADMISSION_DESIGN_AND_OPERATIONS.md) — 입장 제어의 설계 선택, 대가, 한계
4. [PERFORMANCE_REPORT.md](docs/PERFORMANCE_REPORT.md) — 측정 조건, 결과, 해석
5. [RESUME_EVIDENCE.md](docs/RESUME_EVIDENCE.md) — 이력서 문장의 근거

## 코드 읽는 순서

구매 경로:

1. `src/main.ts` — 시작과 종료 순서
2. `src/api/app.ts` — Fastify 앱과 전역 미들웨어
3. `src/infra/migrations/001_init_schema.sql` — 스키마
4. `src/api/rest/checkouts.ts`, `src/core/services/checkout.service.ts` — 주문 생성
5. `src/core/services/inventory.service.ts` — 좌석을 바꾸는 유일한 코드
6. `src/api/rest/payments.ts`, `src/core/services/payment-webhook.service.ts` — 정산과 티켓 발급
7. `src/core/services/reservation.service.ts` — 예약 hold
8. `src/infra/postgres/client.ts` — transaction과 직렬화 재시도

입장 제어:

1. `docs/ADMISSION_CONTRACT.md` — 규칙의 원문
2. `src/infra/redis/admission.ts` — 대기열 전이를 담은 Lua
3. `src/core/services/admission.service.ts`, `src/api/rest/admissions.ts` — 대기열 API
4. `src/core/services/admission-consumption.ts`, migration 012·013 — 입장을 구매에 묶는 원장
5. `src/infra/cron/admission-scheduler.ts` — 승격 scheduler
6. `frontend/admission-polling.js` — 대기 화면의 polling controller

조회: `src/api/graphql/types.ts`, `resolvers.ts`, `loaders.ts`

## 작업 방식

이 저장소는 두 시기에 걸쳐 만들었습니다. 예약·결제·조회 부분(2026-04 – 2026-09)과 입장 제어(2026-09-30 – 2026-10-11)입니다.

입장 제어는 AI 코딩 도구와 함께 만들었습니다. 부하 하네스, 기준선 측정, 계약, 대기열 backend까지는 Codex로, 구매 경로 연결부터 장애 검증, 부하 비교, 문서까지는 Claude Code로 작업했습니다. 이 구간에 더해진 줄은 제품 코드 3,311줄(`src` 1,913, `frontend` 1,398)과 테스트 10,464줄입니다(`git diff --numstat 79a0b5e..94da148 -- src frontend`). 다른 사람의 코드 리뷰는 받지 않았고, 검토는 본인과 도구의 자동 리뷰로 했습니다.

단계마다 설계 설명을 받고 승인한 뒤 구현하게 했고, 병합은 직접 했습니다. 저장소 기록에 날짜와 함께 남아 있는 결정은 다음과 같습니다.

- 구현 전에 대기열 없는 경로부터 측정한다(쓰기 기준선, 2026-10-01).
- 재고 권한은 Redis로 옮기지 않고 메시지 큐도 두지 않는다. 앞단에서 유입만 줄인다.
- 입장량 후보는 실패율과 지연 기준을 미리 정해 두고 pilot으로 거른다. 기준을 못 맞춘 후보는 버린다.
- 구매 경로의 격리 수준은 바꾸지 않는다(2026-10-10, #27).
- 분 단위 대기는 그대로 받아들이고 다시 측정하지 않는다(2026-10-10, #34).
- 고치지 않는 한계는 숨기지 않고 문서에 적는다(설계 문서의 "알려진 한계").
