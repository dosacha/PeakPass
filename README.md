# PeakPass

PeakPass는 고트래픽 워크숍과 세미나를 위한 티켓팅 및 디지털 패스 발급 플랫폼이다.  
Node.js 백엔드 운영, PostgreSQL 트랜잭션, Redis 실사용, GraphQL read-side, Docker 로컬 워크플로우, Terraform 기반 AWS 배포 준비, k6 부하 테스트까지 설명 가능한 백엔드 포트폴리오를 목표로 한다.

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
