# 🎟️ PeakPass

> 고트래픽 워크숍·세미나를 위한 티켓팅 및 디지털 패스 발급 플랫폼

## 📣 프로젝트 소개

워크숍, 세미나, 컨퍼런스처럼 **짧은 시간에 트래픽이 몰리는 이벤트**에서는 두 가지 사고가 자주 일어납니다.
하나는 한 자리에 두 명이 결제되는 **oversell**, 다른 하나는 같은 결제 webhook이 두 번 들어와 **티켓이 중복 발급**되는 일이에요.

PeakPass는 이런 환경에서 **재고 정합성과 결제 멱등성을 보장하는 백엔드**가 어떻게 동작해야 하는지를 직접 구현하고, 부하 테스트와 문서까지 함께 검증한 백엔드 포트폴리오 프로젝트입니다.

Node.js 백엔드 운영, PostgreSQL 트랜잭션, Redis 실사용, GraphQL read-side, k6 부하 테스트까지 — 한 도메인 안에서 백엔드의 핵심 요소를 일관되게 설명할 수 있도록 구성했습니다.

## 🔗 배포 링크

**Live API** — <https://peak-pass.com>

| 엔드포인트 | URL |
| --- | --- |
| Health Check | <https://peak-pass.com/health> |
| Readiness Check | <https://peak-pass.com/ready> |
| REST (write-side) | `https://peak-pass.com/reservations`, `/checkouts`, `/webhooks/payments/settlement` |
| GraphQL (read-side) | <https://peak-pass.com/graphql> |

> 아래 데모 시나리오의 `curl` 명령에서 `http://localhost:3000` 부분을 `https://peak-pass.com`으로 바꾸면 **로컬 세팅 없이 바로** 라이브 API를 호출해볼 수 있어요.

## 🎯 프로젝트 목표

- Node.js + TypeScript 기반 백엔드 서비스 구현
- Fastify 기반 **REST write-side**와 **GraphQL read-side** 분리
- PostgreSQL을 **source of truth**로 유지
- Redis를 hold TTL · rate limit · idempotency · cache에 **실제 운영 용도로** 사용
- 동시성 하에서 oversell을 막는 트랜잭션 흐름 구현
- k6 기반 부하 테스트 시나리오 제공

## ⚙️ 기술 스택

| 영역 | 사용 기술 |
| --- | --- |
| **Language & Runtime** | Node.js, TypeScript |
| **Web Framework** | Fastify (REST), GraphQL |
| **Database** | PostgreSQL |
| **Cache & In-memory** | Redis |
| **Testing** | Jest (단위·통합·동시성), k6 (부하 테스트) |
| **Quality** | ESLint, Prettier |

## 🏗️ 아키텍처 개요

PeakPass는 **상태를 바꾸는 명령**과 **데이터를 읽는 조회**를 의도적으로 다른 프로토콜로 분리했습니다.

### REST는 명령(Write) 처리

- `POST /reservations` — 예약 hold 생성
- `POST /checkouts` — 주문 생성 (결제 대기)
- `POST /webhooks/payments/settlement` — 결제 정산 webhook 처리

> 상태 전이가 핵심인 명령은 REST로 유지합니다. **멱등성 키, HTTP 상태 코드, 트랜잭션 경계**가 가장 단순하게 드러나는 표현이기 때문이에요.

### GraphQL은 조회(Read) 처리

- `events`, `event` — 이벤트 목록 / 상세 조회
- `myOrders`, `myTickets` — 내 주문 / 내 티켓 조회
- `ticketByCode` — 티켓 코드로 단건 조회

> 조회 조합이 많은 read-side는 GraphQL로 분리해, 클라이언트가 필요한 필드만 골라서 가져갈 수 있게 했어요.

### PostgreSQL이 정합성 기준

재고 차감, 주문 생성, 정산 완료 처리, 티켓 발급, 예약 상태 전환 — **정합성이 필요한 모든 흐름은 PostgreSQL 트랜잭션 안에서** 처리합니다.

### Redis는 보조 계층

- 예약 hold TTL
- rate limiting
- idempotency 결과 캐시
- 이벤트 / 재고 캐시

> Redis는 빠른 조회와 보조 역할을 맡지만, **source of truth는 아닙니다.** 부작용은 가능한 한 commit 이후에만 반영해요.

## 🛠️ 주요 기능

### ✅ 이벤트 조회

GraphQL로 이벤트 목록과 상세 정보를 조회할 수 있어요. 필요한 필드만 골라서 가져갈 수 있고, DataLoader로 N+1 문제도 막아두었어요.

### ✅ 예약 Hold 생성

`POST /reservations`로 잠깐 자리를 잡아둘 수 있어요. Redis TTL로 일정 시간이 지나면 자동으로 풀려서, **결제까지 가지 않은 자리는 다른 사용자에게 다시 열려요.**

### ✅ 체크아웃 (주문 생성)

`POST /checkouts`로 주문을 만들어요. 이 시점에서는 **티켓이 발급되지 않고**, 주문 상태는 `pending`으로만 기록돼요. 결제가 정산되기 전에는 절대로 티켓이 나가지 않도록 분리해 두었어요.

### ✅ 결제 Webhook 처리 (정산 → 티켓 발급)

`POST /webhooks/payments/settlement`로 결제 webhook이 들어오면 주문 상태를 `paid`로 바꾸고, **이때 처음으로 티켓이 발급**돼요. 한 webhook = 하나의 트랜잭션 경계예요.

### ✅ 중복 Webhook 방어 (멱등성)

같은 `Idempotency-Key`로 webhook이 다시 들어와도 티켓이 두 번 발급되지 않아요. duplicate 응답을 돌려주되, **티켓 개수는 절대 늘어나지 않아요.** 결제사가 retry 정책을 가지고 있을 때 반드시 필요한 동작이에요.

### ✅ 동시성 제어 (Oversell 방지)

`SERIALIZABLE` 트랜잭션과 `SELECT ... FOR UPDATE`로 이벤트 재고 행을 잠그고, `available_seats`가 0 아래로 내려가지 않도록 제어해요. **부하 테스트에서 동시 예약 요청이 몰려도 한 자리가 두 명에게 팔리지 않는 것을 확인**했어요.

### ✅ Rate Limiting & 캐시

Redis 기반 rate limit으로 API를 보호하고, 이벤트 정보와 재고 정보를 캐시 계층에 두어 **burst 트래픽에도 DB가 무너지지 않도록** 했어요.

### ✅ 내 주문 / 내 티켓 조회

GraphQL `myOrders`, `myTickets`, `ticketByCode`로 사용자가 본인의 주문과 티켓을 자유롭게 조회할 수 있어요. JWT 인증 기반이에요.

### ✅ 부하 테스트 시나리오 (k6)

실제 서비스 트래픽 패턴을 가정한 4개의 시나리오를 제공해요.

| 시나리오 | 대상 | 목적 |
| --- | --- | --- |
| `baseline` | `/health`, GraphQL `events`, GraphQL `event` | 일반 browse 트래픽의 기준선 |
| `spike` | GraphQL `event` | 인기 이벤트 상세 집중 조회 시 tail latency |
| `sustained` | `POST /reservations` | flash-sale 예약 부하 / 429 비율 |
| `callbacks` | `POST /webhooks/payments/settlement` | duplicate webhook에도 티켓 중복 발급이 없는지 |

## 🔒 핵심 정합성 포인트

PeakPass에서 절대 양보하지 않은 규칙들이에요.

- `Idempotency-Key` 기반 **중복 재시도 방어**
- `SERIALIZABLE` 트랜잭션 격리 수준 사용
- `SELECT ... FOR UPDATE` 기반 이벤트 재고 **행 잠금**
- `available_seats`가 **0 아래로 내려가지 않도록** 제어
- checkout 시점에는 주문만 생성 → 티켓은 **settlement 이후에만** 발급
- duplicate settlement webhook에도 **티켓이 중복 발급되지 않음**
- Redis 부작용은 가능한 한 **commit 이후에만** 반영

## 📂 디렉터리 구조

```
src/
  api/         Fastify 앱 조립, REST 라우트, GraphQL 서버, 미들웨어
  core/        도메인 모델, 서비스, 에러
  infra/       PostgreSQL, Redis, 설정, 로거, 마이그레이션, 시드
docs/          아키텍처 / 정합성 / Redis / GraphQL 기술 문서
load-test/     k6 부하 테스트 스크립트
```

## 🚀 빠른 시작

### 1. 의존성 설치

```bash
npm install
```

### 2. 정적 검증

```bash
npm run build
npm test -- --runInBand
npm run lint
```

### 3. 로컬 환경 실행

```bash
docker compose up -d postgres redis
docker compose up -d app
```

기본 포트는 다음과 같아요. (호스트 포트 충돌을 피하기 위해 5433 / 6380을 사용해요.)

| 서비스 | 호스트 포트 | 컨테이너 포트 |
| --- | --- | --- |
| PostgreSQL | `5433` | `5432` |
| Redis | `6380` | `6379` |
| App | `3000` | `3000` |

### 4. 상태 확인

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

## 🎬 데모 시나리오

아래 명령들은 로컬(`http://localhost:3000`)을 기준으로 작성되어 있어요. **`http://localhost:3000`을 `https://peak-pass.com`으로 바꾸면 라이브 API에 그대로 적용**할 수 있어요.

### 1) 이벤트 목록 조회

```bash
curl http://localhost:3000/events
```

### 2) 예약 Hold 생성

```bash
curl -X POST http://localhost:3000/reservations \
  -H "Content-Type: application/json" \
  -d '{"eventId":"EVENT_ID","userId":"USER_ID","quantity":1,"tierId":"TIER_ID"}'
```

### 3) 체크아웃

```bash
curl -X POST http://localhost:3000/checkouts \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 22222222-2222-2222-2222-222222222222" \
  -d '{"eventId":"EVENT_ID","userId":"USER_ID","quantity":1,"tierId":"TIER_ID","reservationId":"RESERVATION_ID"}'
```

이 시점 기대 상태: `order.status = pending`, `tickets = []`

### 4) Settlement Webhook (티켓 발급)

```bash
curl -X POST http://localhost:3000/webhooks/payments/settlement \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 33333333-4444-5555-6666-777777777777" \
  -d '{"orderId":"ORDER_ID","providerTransactionId":"txn-settle-001","status":"settled"}'
```

이 시점 기대 상태: `order.status = paid`, 티켓 발급됨 (예: `PASS-2026-000002`)

### 5) 같은 Settlement Webhook 재시도 (중복 방어 확인)

같은 `Idempotency-Key`로 한 번 더 호출하면 `duplicate: true`로 응답하고, **티켓 수는 늘어나지 않아요.**

### 6) GraphQL로 본인 주문 / 티켓 조회

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer JWT_TOKEN" \
  -d '{"query":"query { myOrders(limit: 10) { id status paymentStatus ticketCount totalPrice } myTickets(limit: 10) { id code status } }"}'
```

## 🧪 테스트

### 단위 / 통합 / 동시성 테스트

```bash
npm test -- --runInBand
npm run test:redis
npm run test:concurrency
```

### 부하 테스트 (k6)

먼저 k6를 설치해 두어야 해요. (Windows 예시)

```bash
winget install k6.k6
k6 version
```

실행 전 앱과 의존성이 떠 있어야 해요.

```bash
docker compose up -d postgres redis
docker compose up -d app
curl http://localhost:3000/health
```

환경 변수(PowerShell 예시):

```powershell
$env:BASE_URL="http://localhost:3000"
$env:LOAD_TEST_USER_ID="USER_ID"
$env:LOAD_TEST_EVENT_ID="EVENT_ID"
$env:LOAD_TEST_TIER_ID="TIER_ID"
```

시나리오 실행:

```bash
npm run load-test:baseline
npm run load-test:spike
npm run load-test:sustained
npm run load-test:callbacks
```

JSON 리포트 저장:

```bash
npm run load-test:baseline:report
npm run load-test:spike:report
npm run load-test:sustained:report
npm run load-test:callbacks:report
```

결과는 `load-test/results/` 아래에 저장돼요. 처음 확인할 지표는 다음과 같아요.

- `http_req_duration` p95, p99
- `http_req_failed`
- reservation 시나리오의 **429 비율**
- callback 시나리오의 **duplicate 응답 비율**

> callback 시나리오는 duplicate 응답이 나와도 괜찮지만, **티켓 수가 늘어나면 절대 안 돼요.**

## 📚 문서

핵심 문서는 `docs/` 안에 있어요. 처음 본다면 이 순서를 추천해요.

1. `docs/ARCHITECTURE_DIAGRAMS.md` — 전체 흐름 파악
2. `docs/TRANSACTION_CONSISTENCY.md` — oversell·중복 발급 방어 로직
3. `docs/REDIS_STRATEGY.md` — Redis 사용 의도와 한계
4. `docs/GRAPHQL_RATIONALE.md` — write / read 분리 이유

## 🗺️ 코드 읽는 순서 (추천)

1. `src/main.ts` — 진입점
2. `src/api/app.ts` — Fastify 앱 조립
3. `src/infra/migrations/001_init_schema.sql` — 도메인 스키마
4. `src/api/rest/checkouts.ts` — 체크아웃 라우트
5. `src/api/rest/payments.ts` — settlement webhook
6. `src/core/services/checkout.service.ts` — 체크아웃 로직
7. `src/core/services/reservation.service.ts` — 예약 hold 로직
8. `src/infra/redis/commands.ts` — Redis 명령
9. `src/api/graphql/types.ts` — GraphQL 스키마
10. `src/api/graphql/resolvers.ts` — 리졸버
11. `src/api/graphql/loaders.ts` — DataLoader
