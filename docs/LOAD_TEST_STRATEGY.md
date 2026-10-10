# 부하 테스트 전략

PeakPass는 읽기 트래픽과 쓰기 트래픽의 성격이 다릅니다.
그래서 k6 시나리오도 순수 성능, rate limit 방어, 결제 webhook 재시도 흐름으로 나눠서 봅니다.

## 문서 상태

- 최신 측정 결과: [PERFORMANCE_REPORT.md](./PERFORMANCE_REPORT.md)
- 본 문서는 시나리오 설계 기준을 설명합니다.
- 아래 "시나리오" 1–6은 시나리오별 micro-benchmark입니다. 서로 다른 구매자가 한 이벤트에 몰리는 쓰기 부하는 맨 아래 "flash-sale 하네스"가 다룹니다.

## 시나리오

### 실행 환경 분리

순수 성능/idempotency 측정은 rate limit이 결과를 오염시키지 않도록 perf compose를 사용합니다.

```bash
docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d --force-recreate app

until curl -sf http://localhost:3000/ready > /dev/null; do
  sleep 2
done

docker compose -f docker-compose.yml -f docker-compose.perf.yml exec redis redis-cli FLUSHDB
```

Rate limit 동작 측정은 기본 compose를 사용합니다.

```bash
docker compose up -d --force-recreate app

until curl -sf http://localhost:3000/ready > /dev/null; do
  sleep 2
done

docker compose exec redis redis-cli FLUSHDB
```

### 1. baseline browse traffic

- 목적: 일반 조회 트래픽 기준선 측정
- 대상: `/health`, GraphQL `events`, GraphQL `event`
- 스크립트: [baseline.js](../load-test/baseline.js)
- 실행 환경: perf compose

```bash
npm run load-test:baseline
```

### 2. burst event-detail query traffic

- 목적: 특정 이벤트 상세 조회가 갑자기 몰릴 때 응답성 확인
- 대상: GraphQL `event`
- 스크립트: [spike.js](../load-test/spike.js)
- 실행 환경: perf compose

```bash
npm run load-test:spike
```

### 3. duplicate / retry-heavy payment callback traffic

- 목적: 같은 settlement webhook이 여러 번 들어와도 중복 발급이 생기지 않는지 확인
- 대상: `POST /webhooks/payments/settlement`
- 스크립트: [payment-callback.js](../load-test/payment-callback.js)
- 실행 환경: perf compose

필수 환경 변수는 다음과 같습니다.

- `LOAD_TEST_USER_ID`
- `LOAD_TEST_EVENT_ID`
- `LOAD_TEST_TIER_ID`

```bash
npm run load-test:callbacks
```

### 4. GraphQL rate limit traffic

- 목적: GraphQL read 경로가 rate limit 초과 시 빠르게 429를 반환하는지 확인
- 대상: `POST /graphql`
- 스크립트: [graphql-rate-limit.js](../load-test/graphql-rate-limit.js)
- 실행 환경: 기본 compose

```bash
npm run load-test:rate-limit:graphql
```

### 5. reservation rate limit traffic

- 목적: reservation write 경로가 rate limit 초과 시 빠르게 429를 반환하는지 확인
- 대상: `POST /reservations`
- 스크립트: [reservation-rate-limit.js](../load-test/reservation-rate-limit.js)
- 실행 환경: 기본 compose

필수 환경 변수는 다음과 같습니다.

- `LOAD_TEST_USER_ID`
- `LOAD_TEST_EVENT_ID`
- `LOAD_TEST_TIER_ID`

```bash
npm run load-test:rate-limit:reservations
```

### 6. flash-sale reservation traffic

- 목적: 플래시세일 상황에서 reservation hold API의 응답 시간과 rate limiting 동작 확인
- 대상: `POST /reservations`
- 스크립트: [sustained.js](../load-test/sustained.js)
- 실행 환경: 측정 목적에 따라 perf compose 또는 기본 compose

필수 환경 변수는 다음과 같습니다.

- `LOAD_TEST_USER_ID`
- 선택: `LOAD_TEST_EVENT_ID`, `LOAD_TEST_TIER_ID`

```bash
npm run load-test:sustained
```

## 관찰 지표

- p95, p99 응답 시간
- 에러율 / unexpected error율
- 429 비율
- duplicate webhook 응답 비율
- DB 연결 수
- Redis 명령 응답 시간 (rate limit / idempotency 경로)

## 해석 포인트

- browse 시나리오에서 p95가 안정적이면 GraphQL(DataLoader batching)과 PostgreSQL 직접 조회가 부하를 감당하는 것으로 봅니다. (이벤트/재고 read-through cache는 현재 미구현)
- event detail spike에서 tail latency가 급격히 올라가면 그때 read-through cache 도입을 검토합니다.
- rate limit 시나리오에서 429가 높고 `*_unexpected_errors`가 0%이면 rate limit이 의도대로 동작하는 것으로 봅니다.
- payment callback 부하에서 duplicate 응답은 늘 수 있지만 티켓 수가 늘면 안 됩니다.

## 권장 실행 순서

1. baseline
2. spike
3. callbacks
4. graphql rate limit
5. reservation rate limit
6. 필요 시 sustained
7. 결과 비교와 병목 정리

## 현재 메모

- 스크립트는 현재 REST write-side와 GraphQL read-side 구조에 맞춰 갱신했습니다.
- baseline / spike / callbacks / rate-limit 측정 흐름을 분리했습니다.
- 측정 결과 해석은 `docs/PERFORMANCE_REPORT.md`의 "측정 결과" 섹션을 참조합니다.

## flash-sale 하네스 (인증된 쓰기 부하)

위 시나리오는 한 사용자가 한 행을 반복해 두드립니다. 실제 판매 개시는 서로 다른 구매자가 정해진 속도로 도착해 예약 → checkout → 정산까지 가는 흐름이라, 별도 하네스로 측정합니다.

- **구성.** `load-test/flash-sale-fixture.mjs`가 실행마다 자체 PostgreSQL 16, Redis 7, 현재 코드로 빌드한 production 앱을 `docker-compose.flash-sale.yml`로 띄우고, 구매자와 JWT를 만들고, k6(`load-test/flash-sale.js`)를 돌린 뒤 SQL 증거를 저장하고 그 실행의 자원만 지웁니다. `load-test/flash-sale-analysis.mjs`가 결과를 판정합니다.
- **부하 모델.** VU 수가 아니라 도착률로 정합니다(초당 N명이 M초 동안 도착). 처음 몇 초의 구매자는 warmup이고 나머지가 측정 cohort입니다. 도착이 끝난 뒤 drain 시간 동안 진행 중인 구매를 기다립니다.
- **세 arm.** `--arm a`는 대기열 없음, `b`는 대기열과 fixed polling, `c`는 같은 대기열과 adaptive polling입니다. 세 arm은 같은 commit, 같은 Compose 파일을 쓰고 이벤트의 보호 여부와 polling 방식만 다릅니다. 대기열 arm의 구매자는 페이지가 쓰는 `frontend/admission-polling.js`를 수정 없이 실행합니다.
- **분모.** 도착한 구매자는 결과가 무엇이든 분모에서 빠지지 않습니다. 구매 시도 실패율은 예약·checkout·정산 요청 가운데 하네스가 일부러 보내는 replay를 뺀 것만 세고, 대기열 조회와 등록은 따로 셉니다.
- **유효성.** 측정이 성립하지 않은 실행(발생기 지연, 표본 누락, 환경 불일치 등)은 invalid로 남기고 통계에서 뺍니다. 기준을 못 맞춘 것은 invalid가 아니라 결과입니다. 수량이나 원장이 어긋나면 integrity defect입니다.
- **반복.** arm당 3회를 번갈아 실행하고 중앙값과 최소–최대를 냅니다. percentile을 실행 사이에 합치지 않습니다.

```bash
npm run build
npm run test:flash-sale
npm run load-test:flash-sale -- --run-id my-run-01 --arm c --users 1000 --rate 50 --warmup-seconds 5 --pre-vus 1000 --max-vus 1000 --drain-seconds 900
```

입력과 산출 파일, 판정 규칙의 원문은 [FLASH_SALE_EVIDENCE.md](./FLASH_SALE_EVIDENCE.md), 기준선은 [FLASH_SALE_BASELINE.md](./FLASH_SALE_BASELINE.md), A/B/C 비교의 프로토콜과 결과는 [ISSUE_17_VALIDATION.md](./ISSUE_17_VALIDATION.md)에 있습니다.
