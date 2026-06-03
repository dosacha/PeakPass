# 성능 보고서

이 문서는 현재 저장소에 포함된 k6 시나리오, 관찰 지점, 그리고 commit된 측정 결과를 정리합니다.

## 포함된 부하 테스트 스크립트

- [baseline.js](../load-test/baseline.js)
- [spike.js](../load-test/spike.js)
- [sustained.js](../load-test/sustained.js)
- [payment-callback.js](../load-test/payment-callback.js)
- [graphql-rate-limit.js](../load-test/graphql-rate-limit.js)
- [reservation-rate-limit.js](../load-test/reservation-rate-limit.js)

## 시나리오 목적

### baseline

- 일반 browse 트래픽 기준선 측정
- GraphQL `events`, `event`의 응답 시간 확인

### spike

- 특정 이벤트 상세 조회가 몰릴 때 tail latency 확인
- hot read 경로의 cache 효율과 DB 부하 확인

### sustained

- 플래시세일 예약 부하에서 `POST /reservations` 응답 시간 확인
- 429 비율과 reservation hold 생성량 확인

### payment callbacks

- 같은 settlement webhook이 반복될 때 duplicate 처리 확인
- 이미 처리된 order에 대해 추가 티켓이 발급되지 않는지 확인

### graphql rate limit

- GraphQL read 경로의 rate limiter가 429를 fail-fast로 반환하는지 확인
- 429 외 예기치 않은 오류가 섞이지 않는지 확인

### reservation rate limit

- reservation write 경로의 rate limiter가 429를 fail-fast로 반환하는지 확인
- 429 / 409 / 201 외 예기치 않은 응답이 섞이지 않는지 확인

## 현재 코드와 연결된 지점

- 조회 성능: GraphQL `events`, `event`
- 예약 성능: `POST /reservations`
- 결제 재시도 안정성: `POST /webhooks/payments/settlement`
- 방어 장치: Redis rate limit, idempotency result cache, event cache

## 관찰할 메트릭

- `http_req_duration` p50, p95, p99
- `http_req_failed`
- 초당 처리량
- 429 비율
- duplicate callback 비율
- PostgreSQL 연결 수
- Redis 응답 시간

## 좋은 결과 예시

- baseline에서 p95가 안정적임
- spike 이후 빠르게 회복함
- reservation 부하 중 429가 비정상적으로 치솟지 않음
- callback 부하 중 duplicate 응답은 나오더라도 티켓 수는 증가하지 않음

## 나쁜 신호 예시

- browse p95가 급격히 늘어남
- event detail spike 이후 recovery가 느려짐
- reservation 부하에서 429 없이 DB 에러가 먼저 늘어남
- callback 재시도에서 새 티켓이 추가 생성됨

## 현재 메모

- 순수 성능/idempotency 측정과 rate limit 측정은 분리함
- 순수 성능/idempotency 측정은 `docker-compose.perf.yml`로 rate limit을 높이고 `node dist/main.js`로 실행함
- rate limit 측정은 기본 `docker-compose.yml` 설정을 사용함
- `http_req_failed`는 rate limit 시나리오에서 429를 failed response로 집계하므로, 해당 시나리오는 `*_unexpected_errors`를 성공 기준으로 봄

## 측정 환경 (2026-06-03)

| 항목 | 값 |
|---|---|
| Hardware | 로컬 개발 머신 (Docker Desktop) |
| Runtime | Node.js 18 컨테이너, PostgreSQL 16, Redis 7, 모두 Docker Compose 단일 노드 |
| 클라이언트 | k6, 같은 머신에서 `localhost:3000`로 호출 |
| `NODE_ENV` | `development` |
| 순수 성능 환경 | `docker-compose.yml` + `docker-compose.perf.yml` |
| rate limit 환경 | 기본 `docker-compose.yml` |
| `ENFORCE_AUTH_USER_MATCH` | `false` (k6 스크립트가 JWT를 발급하지 않으므로) |
| `RATE_LIMIT_FAIL_MODE` | `closed` (default) |
| 데이터셋 | seed.ts로 생성한 이벤트 2개, user 3개 |

### 실행 모드

순수 성능/idempotency 측정:

```bash
docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d --force-recreate app

until curl -sf http://localhost:3000/ready > /dev/null; do
  sleep 2
done

docker compose -f docker-compose.yml -f docker-compose.perf.yml exec redis redis-cli FLUSHDB
```

이 모드는 다음 값을 사용합니다.

| 변수 | 값 |
|---|---:|
| `GRAPHQL_RATE_LIMIT_MAX_REQUESTS` | `100000` |
| `RATE_LIMIT_MAX_REQUESTS` | `100000` |

Rate limit 측정:

```bash
docker compose up -d --force-recreate app

until curl -sf http://localhost:3000/ready > /dev/null; do
  sleep 2
done

docker compose exec redis redis-cli FLUSHDB
```

### 시나리오 부하 모델

`load-test/sustained.js`는 **단일 `LOAD_TEST_USER_ID`를 다수 VU가 공유하는** micro-benchmark 형태입니다. 같은 user / 같은 event / 같은 tier에 대한 reservation 요청이 다수 VU에서 들어가므로, 측정 결과는 *동일 row에 대한 lock 경합* 시나리오에 가깝습니다. distinct user N명이 같은 event에 몰리는 본격 flash-sale 모델 측정은 후속 과제입니다.

이 형태로 측정해도 **단일 event row에 대한 lock 직렬화 비용**은 의미 있는 정보이고, GraphQL read p95가 흔들리지 않는지·rate limit on / off가 throughput에 어떻게 반영되는지는 확인 가능합니다. 다만 본 결과를 "실서비스 환경의 flash-sale RPS 추정치"로 일반화하지 말아 주세요.

## 측정 결과 (2026-06-03 갱신, 위 환경)

| 시나리오 | 결과 파일 | 부하 모델 | rate limit | RPS | p95 latency | 에러율 |
|---|---|---|---|---|---|---|
| read baseline (50 VU 10분) | `baseline-summary.json` | GraphQL `events` / `event` mix + `/health` | perf override | 107.3 HTTP req/s | `browse_latency_ms` p95 29.2 ms | `browse_errors` 0.00% |
| read spike (200 VU) | `spike-summary.json` | GraphQL `event` 단일 id 반복 | perf override | 663.6 HTTP req/s | `event_detail_spike_latency_ms` p95 5.7 ms | `event_detail_spike_errors` 0.00% |
| payment callback duplicate retry (50 VU) | console output | 단일 order에 settlement webhook 반복 | perf override | 271.6 HTTP req/s | `payment_callback_latency_ms` p95 5.0 ms | `payment_callback_errors` 0.00% |
| GraphQL rate limit | console output | GraphQL `events` 반복 | default | 197.5 HTTP req/s | `graphql_rate_limit_latency_ms` p95 4.0 ms | `graphql_unexpected_errors` 0.00%, 99.13% rate-limited |
| reservation rate limit | console output | 단일 user → 단일 event / tier reservation 반복 | default | 240.3 HTTP req/s | `reservation_rate_limit_latency_ms` p95 3.3 ms | `reservation_unexpected_errors` 0.00%, 99.94% rate-limited |

### 해석

- **read 경로**: rate limit을 높인 perf 환경에서 baseline과 200 VU spike 모두 0% 오류로 통과함. spike p95 5.7 ms로 hot event detail read가 안정적으로 처리됨
- **payment callback**: 단일 order에 settlement webhook을 반복해도 대부분 duplicate로 안정 처리됨. `payment_callback_duplicates=19055`, `payment_callback_errors=0.00%`
- **GraphQL rate limit**: 기본 설정에서 99.13%가 rate-limited 되었고, 예기치 않은 오류는 0%임. read limiter가 fail-fast로 동작함
- **reservation rate limit**: 기본 설정에서 99.94%가 rate-limited 되었고, 예기치 않은 오류는 0%임. write limiter가 fail-fast로 동작함
- **HTTP failed 해석**: rate limit 시나리오에서 `http_req_failed`가 99%대로 나오는 것은 429가 k6의 HTTP failed response로 집계되기 때문이며, 성공 기준은 커스텀 unexpected error 지표임

### 본 측정의 한계 (정직한 disclaimer)

1. 단일 user 부하 모델이라 *서로 다른 user가 같은 event에 몰리는* 실제 flash-sale의 lock 분포와 다름. 진짜 oversell 방어 검증은 `src/tests/integration/concurrency.test.ts`에서 5명의 distinct user로 수행함
2. `ENFORCE_AUTH_USER_MATCH=false`로 측정함. 권장값(`true`)에서는 JWT 발급 흐름이 추가되며 이는 현 부하 스크립트가 모델링하지 않음
3. 단일 노드 Docker Compose 환경. 분산 환경의 cold connection, cross-region latency, DB 연결 풀 동작 등은 측정 범위 밖
4. PostgreSQL / Redis 자체의 메모리·디스크 한계는 시나리오 길이(최대 3분 20초)로는 의미 있게 드러나지 않음
