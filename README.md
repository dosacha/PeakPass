# PeakPass

**Live demo:** https://peak-pass.com · `/health` · `/ready`  
**Stack:** TypeScript · Fastify · Apollo GraphQL · PostgreSQL 16 · Redis 7 · Docker Compose · Nginx · AWS EC2 · Let's Encrypt

실시간 티켓 발급 서비스의 핵심 흐름(Reservation → Payment → Ticket issuance)을 단일 서비스 수준에서 재현한 학습용 백엔드 모노레포입니다.

## 프로젝트 성격

**개인 학습 프로젝트입니다.** 실제 운영 트래픽에서 검증된 시스템이 아니며, "티켓팅 도메인의 정합성/멱등성 문제를 코드로 설명 가능한 수준까지 끌고 가는 것"을 목표로 작성했습니다.

개발 과정에서 AI 코드 어시스턴트를 사용했습니다. 설계 의사결정(트랜잭션 경계, 상태 전이 정의, 멱등 경로 구조, 테스트 시나리오)은 직접 수행했고, 구현 세부는 AI 보조를 받아 작성한 뒤 검토했습니다. 초기 커밋은 로컬에서 반복 개발한 결과를 정리해 한 번에 올린 상태입니다 (후속 개선은 의미 단위 커밋으로 진행 예정).

## 프론트엔드 데모

`frontend/` 디렉토리의 정적 React 데모 UI는 예약 → 결제 → 티켓 발급 플로우를 시각적으로 시뮬레이션합니다. 빌드 파이프라인 없이 React UMD + Babel standalone CDN으로 동작합니다.

- **mock 모드 (기본):** 브라우저 내에서 전체 백엔드 로직을 시뮬레이션합니다.
- **live 모드:** 실제 PeakPass 백엔드 API를 호출합니다. 토글로 전환 가능.
- **의도된 제한:** live 모드의 webhook 시뮬레이션은 클라이언트가 HMAC 서명을 가지고 있지 않아 401로 거부됩니다. 이는 프론트엔드에 secret을 노출하지 않는 정상 동작이며, 서명 검증의 필요성을 시각적으로 드러내는 학습 포인트입니다.

**서빙 구조:** 정적 자산(`frontend/`)은 Nginx가 직접 서빙하고, API 경로(`/reservations`, `/checkouts`, `/webhooks/*`, `/graphql`, `/health`, `/ready` 등)만 Fastify 앱(`127.0.0.1:3000`)으로 프록시합니다. 이렇게 분리하면 앱 서버의 이벤트 루프가 정적 자산 요청으로 점유되지 않고, 정적 자산 응답에만 약한 CSP(`unsafe-eval` 허용 — Babel standalone 런타임 트랜스파일용)가 적용되어 API 응답의 보안 헤더가 끌어내려지지 않습니다.

## 한계 (Limitations)

인지하고 있는 구조적 한계입니다. 실제 운영 환경 적용 시 보강이 필요한 항목:

- `POST /checkouts`, `POST /reservations`는 body의 `userId`를 신뢰. 실제 환경에서는 JWT subject와 대조하거나 body userId를 제거하고 인증 주체에서 파생해야 함
- Webhook 서명 검증은 `WEBHOOK_SIGNING_SECRET`이 설정된 경우 HMAC-SHA256으로 수행함. 커스텀 JSON parser가 raw body(Buffer)를 보존해 Provider 원본 바이트에 대한 서명을 검증하며, 타임스탬프 헤더 기반 replay-window 검증은 후속 보강 과제
- Redis idempotency lock은 처리 중 중복 진입을 줄이는 조정 계층이며, Redis 장애 시 PostgreSQL unique 제약이 최종 데이터 무결성 방어선

## 배포 구성

현재 데모는 AWS EC2(t3.small, 서울 리전) 단일 노드에 Docker Compose로 전체 스택을 올린 구성입니다.

- Nginx가 80/443에서 정적 데모 UI를 직접 서빙하고 API 경로만 `127.0.0.1:3000` 앱 컨테이너로 프록시
- Postgres/Redis는 외부 포트 미노출, 같은 Docker 네트워크에서만 접근
- Let's Encrypt 인증서 자동 갱신 (certbot systemd timer)
- Route 53 + Elastic IP로 고정 도메인(`peak-pass.com`) 연결

`terraform/` 디렉토리에는 ECS Fargate + RDS + ElastiCache 기반의 프로덕션급 구성을 별도로 코드화해 두었습니다. 실제 AWS apply는 수행하지 않고 `terraform fmt`·`terraform validate`까지 검증했습니다. 현 데모 구성과 Terraform 구성의 차이는 "학습 데모 단일 노드" 대 "프로덕션 분산 구성"의 대비로 의도된 것입니다.

## 프로젝트 목표

- Node.js + TypeScript 기반 백엔드 서비스 구현
- Fastify 기반 REST write-side와 GraphQL read-side 분리
- PostgreSQL을 source of truth로 유지
- Redis를 hold TTL, rate limit, idempotency, cache에 실제 사용
- 동시성 하에서 oversell을 막는 트랜잭션 흐름 구현
- Docker Compose 기반 로컬 실행 흐름 제공
- Terraform 기반 AWS 배포 구조 제공
- k6 기반 부하 테스트 시나리오 제공

## 핵심 설계

### REST는 명령 처리

- `POST /reservations`
- `POST /checkouts`
- `POST /webhooks/payments/settlement`

예약 생성, 체크아웃, 정산 webhook은 상태를 바꾸는 명령이므로 REST로 유지한다.  
이 방식이 멱등성 키, 상태 코드, 트랜잭션 경계를 가장 단순하게 드러낸다.

### GraphQL은 조회 처리

- 이벤트 목록
- 이벤트 상세
- 내 주문
- 내 티켓
- 티켓 코드 조회

조회 조합이 많은 read-side는 GraphQL로 분리했다.  
현재 `events`, `event`, `myOrders`, `myTickets`, `ticketByCode`는 실제 DB 데이터를 읽는 상태까지 확인했다.

### PostgreSQL이 정합성 기준

- 재고 차감
- 주문 생성
- 정산 완료 처리
- 티켓 발급
- 예약 상태 전환

정합성이 필요한 핵심 흐름은 PostgreSQL 트랜잭션 안에서 처리한다.

### Redis는 보조 계층

- 예약 hold TTL
- rate limiting
- idempotency 결과 캐시
- 이벤트 캐시 / 재고 캐시

Redis는 빠른 조회와 운영 보조 역할을 맡지만 source of truth는 아니다.

## 주요 정합성 포인트

- `Idempotency-Key` 기반 중복 재시도 방어
- `SERIALIZABLE` 트랜잭션 사용
- `SELECT ... FOR UPDATE` 기반 이벤트 재고 행 잠금
- `available_seats`가 0 아래로 내려가지 않도록 제어
- checkout에서는 주문만 생성하고 티켓은 settlement 이후에만 발급
- duplicate settlement webhook에도 티켓이 중복 발급되지 않도록 처리
- Redis 부작용은 가능하면 commit 이후에만 반영

## 디렉터리 구조

```text
src/
  api/        Fastify 앱 조립, REST 라우트, GraphQL 서버, 미들웨어
  core/       도메인 모델, 서비스, 에러
  infra/      PostgreSQL, Redis, 설정, 로거, 마이그레이션, 시드
docs/         아키텍처, 정합성, Redis, GraphQL, 운영 문서
load-test/    k6 부하 테스트 스크립트
terraform/    AWS 배포용 Terraform 코드
```

## 빠른 시작

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

현재 기준 검증 상태:

- `npm run build` 통과
- `npm test -- --runInBand` 통과
- `npm run lint` 통과
- lint 경고로 `no-explicit-any` 17건 잔존

### 3. 로컬 인프라 실행

```bash
docker compose up -d postgres redis
docker compose up -d app
```

현재 compose 포트:

- PostgreSQL: `localhost:5433 -> container 5432`
- Redis: `localhost:6380 -> container 6379`

호스트 포트 충돌을 피하기 위해 현재는 위 포트를 사용한다.

### 4. 상태 확인

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

## 로컬 데모 순서

### 이벤트 목록 조회

```bash
curl http://localhost:3000/events
```

### 예약 hold 생성

```bash
curl -X POST http://localhost:3000/reservations \
  -H "Content-Type: application/json" \
  -d '{"eventId":"EVENT_ID","userId":"USER_ID","quantity":1,"tierId":"TIER_ID"}'
```

### 체크아웃

```bash
curl -X POST http://localhost:3000/checkouts \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 22222222-2222-2222-2222-222222222222" \
  -d '{"eventId":"EVENT_ID","userId":"USER_ID","quantity":1,"tierId":"TIER_ID","reservationId":"RESERVATION_ID"}'
```

이 시점의 기대 상태:

- order status: `pending`
- tickets: 빈 배열

### settlement webhook

```bash
curl -X POST http://localhost:3000/webhooks/payments/settlement \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 33333333-4444-5555-6666-777777777777" \
  -d '{"orderId":"ORDER_ID","providerTransactionId":"txn-settle-001","status":"settled"}'
```

`WEBHOOK_SIGNING_SECRET`이 설정된 환경에서는 요청 body의 HMAC-SHA256 hex digest를 `X-Webhook-Signature` 헤더로 함께 보내야 한다.

이 시점의 기대 상태:

- order status: `paid`
- tickets: 발급됨

### 같은 settlement webhook 재시도

```bash
curl -X POST http://localhost:3000/webhooks/payments/settlement \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 33333333-4444-5555-6666-777777777777" \
  -d '{"orderId":"ORDER_ID","providerTransactionId":"txn-settle-001","status":"settled"}'
```

기대 결과:

- duplicate 처리
- 티켓 수 증가 없음

### GraphQL 조회

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer JWT_TOKEN" \
  -d '{"query":"query { myOrders(limit: 10) { id status paymentStatus ticketCount totalPrice } myTickets(limit: 10) { id code status } }"}'
```

## 실제로 확인한 것

로컬 Docker 환경에서 다음 응답을 실제로 확인했다.

- `GET /health`
- `GET /ready`
- GraphQL `events`
- REST `POST /reservations`
- REST `POST /checkouts`
- REST `POST /webhooks/payments/settlement`
- GraphQL `myOrders`
- GraphQL `myTickets`
- GraphQL `ticketByCode`

실제 검증 중 확인한 대표 데이터:

- checkout 직후 티켓 없음:
  - 주문 ID: `a63a537d-64f4-447a-8c02-91d01cc9ad40`
- settlement 후 발급된 티켓:
  - 티켓 번호: `PASS-2026-000002`
- duplicate settlement 재시도:
  - `duplicate: true`
  - 티켓 수 증가 없음

## 테스트

```bash
npm test -- --runInBand
npm run test:redis
npm run test:concurrency
```

## 부하 테스트

```bash
npm run load-test:baseline
npm run load-test:spike
npm run load-test:sustained
npm run load-test:callbacks
```

결과 저장:

```bash
npm run load-test:baseline:report
npm run load-test:spike:report
npm run load-test:sustained:report
npm run load-test:callbacks:report
```

### k6 설치

Windows 기준 예시:

```bash
winget install k6.k6
```

설치 확인:

```bash
k6 version
```

### 실행 전 준비

앱과 의존성이 먼저 떠 있어야 한다.

```bash
docker compose up -d postgres redis
docker compose up -d app
```

상태 확인:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/ready
```

### 환경 변수

조회 시나리오는 `BASE_URL`만 있으면 된다.

```powershell
$env:BASE_URL="http://localhost:3000"
```

쓰기 시나리오는 아래 값을 같이 넣는 편이 안전하다.

- `LOAD_TEST_USER_ID`
- `LOAD_TEST_EVENT_ID`
- `LOAD_TEST_TIER_ID`

PowerShell 예시:

```powershell
$env:BASE_URL="http://localhost:3000"
$env:LOAD_TEST_USER_ID="USER_ID"
$env:LOAD_TEST_EVENT_ID="EVENT_ID"
$env:LOAD_TEST_TIER_ID="TIER_ID"
```

### 시나리오 설명

`load-test:baseline`

- 대상: `/health`, GraphQL `events`, GraphQL `event`
- 목적: 일반 browse 트래픽 기준선 확인

`load-test:spike`

- 대상: GraphQL `event`
- 목적: 특정 이벤트 상세 조회 집중 시 tail latency 확인

`load-test:sustained`

- 대상: `POST /reservations`
- 목적: flash-sale reservation 부하와 429 비율 확인

`load-test:callbacks`

- 대상: `POST /webhooks/payments/settlement`
- 목적: duplicate webhook에도 티켓이 중복 발급되지 않는지 확인

### 결과 파일

report 스크립트를 사용하면 JSON 파일이 아래 위치에 저장된다.

- `load-test/results/baseline.json`
- `load-test/results/spike.json`
- `load-test/results/sustained.json`
- `load-test/results/callbacks.json`

### 처음 볼 지표

- `http_req_duration` p95, p99
- `http_req_failed`
- reservation 시나리오의 429 비율
- callback 시나리오의 duplicate 응답 비율

callback 시나리오는 duplicate 응답이 나와도 괜찮지만, 티켓 수가 늘어나면 안 된다.

## Docker 명령

```bash
npm run docker:build
npm run docker:up
npm run docker:down
npm run docker:logs
```

## Terraform

기본 순서:

```bash
cd terraform
terraform init
terraform fmt -check -recursive
terraform validate
terraform plan
```

예시 변수 파일:

- `terraform/terraform.tfvars.example`

## 문서

공개 문서 인덱스:

- [docs/README.md](C:/Users/dosac/projects/PeakPass/docs/README.md)

우선 추천 문서:

- [docs/ARCHITECTURE_DIAGRAMS.md](C:/Users/dosac/projects/PeakPass/docs/ARCHITECTURE_DIAGRAMS.md)
- [docs/TRANSACTION_CONSISTENCY.md](C:/Users/dosac/projects/PeakPass/docs/TRANSACTION_CONSISTENCY.md)
- [docs/REDIS_STRATEGY.md](C:/Users/dosac/projects/PeakPass/docs/REDIS_STRATEGY.md)
- [docs/GRAPHQL_RATIONALE.md](C:/Users/dosac/projects/PeakPass/docs/GRAPHQL_RATIONALE.md)
- [docs/DEPLOYMENT_RUNBOOK.md](C:/Users/dosac/projects/PeakPass/docs/DEPLOYMENT_RUNBOOK.md)

## 현재 상태 메모

- 설치, 빌드, 테스트, lint는 복구된 상태
- checkout 정합성 흐름은 구현되어 있음
- settlement webhook 이후 티켓 발급 흐름을 실제로 확인함
- duplicate settlement webhook에도 중복 발급이 나지 않음을 확인함
- Docker Compose 기반 로컬 end-to-end 검증까지 수행함
- Terraform 파일은 존재하지만 로컬 CLI 부재로 재검증은 미실행

## 처음 읽을 때 추천 순서

1. `src/main.ts`
2. `src/api/app.ts`
3. `src/infra/migrations/001_init_schema.sql`
4. `src/api/rest/checkouts.ts`
5. `src/api/rest/payments.ts`
6. `src/core/services/checkout.service.ts`
7. `src/core/services/reservation.service.ts`
8. `src/infra/redis/commands.ts`
9. `src/api/graphql/types.ts`
10. `src/api/graphql/resolvers.ts`
11. `src/api/graphql/loaders.ts`
