# 성능 보고서

이 문서는 현재 저장소에 포함된 k6 시나리오, 관찰 지점, 그리고 commit된 측정 결과를 정리합니다.

## 포함된 부하 테스트 스크립트

- [baseline.js](../load-test/baseline.js)
- [spike.js](../load-test/spike.js)
- [sustained.js](../load-test/sustained.js)
- [payment-callback.js](../load-test/payment-callback.js)

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

- 스크립트는 현재 API 구조와 settlement 이후 발급 흐름을 반영함
- baseline / spike / sustained 결과는 commit으로 고정됨 (아래 측정 결과 참조)
- payment-callback 시나리오는 HMAC `X-Webhook-Timestamp` 서명 패턴 반영 후 결과 추가 예정 (현재 script는 secret 미설정 환경에서만 실행 가능)

## 측정 환경 (2026-05-05)

| 항목 | 값 |
|---|---|
| Hardware | 로컬 개발 머신 (Windows + WSL2 또는 Docker Desktop) |
| Runtime | Node.js 20, PostgreSQL 16, Redis 7, 모두 Docker Compose 단일 노드 |
| 클라이언트 | k6, 같은 머신에서 `localhost:3000`로 호출 |
| `NODE_ENV` | `development` |
| `ENABLE_RATE_LIMITING` | 시나리오별로 명시 (아래 표 참조) |
| `ENFORCE_AUTH_USER_MATCH` | `false` (k6 스크립트가 JWT를 발급하지 않으므로) |
| `RATE_LIMIT_FAIL_MODE` | `closed` (default) |
| 데이터셋 | seed.ts로 생성한 단일 이벤트 + 단일 tier, `total_seats`는 시나리오 처리량을 견딜 수 있도록 충분히 크게 설정 |

### 시나리오 부하 모델

`load-test/sustained.js`는 **단일 `LOAD_TEST_USER_ID`를 다수 VU가 공유하는** micro-benchmark 형태입니다. 같은 user / 같은 event / 같은 tier에 대한 reservation 요청이 다수 VU에서 들어가므로, 측정 결과는 *동일 row에 대한 lock 경합* 시나리오에 가깝습니다. distinct user N명이 같은 event에 몰리는 본격 flash-sale 모델 측정은 후속 과제입니다.

이 형태로 측정해도 **단일 event row에 대한 lock 직렬화 비용**은 의미 있는 정보이고, GraphQL read p95가 흔들리지 않는지·rate limit on / off가 throughput에 어떻게 반영되는지는 확인 가능합니다. 다만 본 결과를 "실서비스 환경의 flash-sale RPS 추정치"로 일반화하지 말아 주세요.

## 측정 결과 (2026-05-06 갱신, 위 환경)

| 시나리오 | 결과 파일 | 부하 모델 | rate limit | RPS | p95 latency | 에러율 |
|---|---|---|---|---|---|---|
| read spike (200 VU) | `spike-summary.json` | GraphQL `event` 단일 id 반복 | off | 653.2 | 17.9 ms | 0% |
| read baseline (50 VU 10분) | `baseline-summary.json` | GraphQL `events` / `event` mix + `/health` | off | 109.5 | 11.5 ms | 0% |
| write reservation sustained (150 VU) | `sustained-reservation-2026-05-05-2208.json` | 단일 user → 단일 event / tier reservation 반복 | **off** | 258.4 | 486 ms | 0% |
| write reservation, rate limit on, 동일 부하 | `sustained-2026-05-05-2119.json` | 위와 동일 + `ENABLE_RATE_LIMITING=true` | **on** | 1,059.6 | 6.0 ms | 100% rate-limited |

### 해석

- **read 경로**: 200 VU spike에서도 p95 16 ms로 흔들리지 않음 (cache hit + 단순 SELECT)
- **write 경로 (rate limit off)**: SERIALIZABLE + FOR UPDATE + Redis hold를 모두 거치는 *완전한* reservation 흐름에서 258 RPS, 0% 에러. p95 486 ms는 단일 row lock 경합의 직렬화 cost가 그대로 반영된 결과
- **write 경로 (rate limit on)**: 1,060 RPS의 사실상 100%가 fail-fast 거부됨 (p95 6 ms) → fail-closed 정책의 정량 검증. 같은 user_id가 RATE_LIMIT_MAX_REQUESTS(default 5) / RATE_LIMIT_WINDOW_MS(default 60000) 안에서만 통과하므로 윈도우 첫 5건 이후 모든 요청이 차단됨
- **payment-callback**: 결과 미고정 (HMAC header 반영 후 추가 예정)

### 본 측정의 한계 (정직한 disclaimer)

1. 단일 user 부하 모델이라 *서로 다른 user가 같은 event에 몰리는* 실제 flash-sale의 lock 분포와 다름. 진짜 oversell 방어 검증은 `src/tests/integration/concurrency.test.ts`에서 5명의 distinct user로 수행함
2. `ENFORCE_AUTH_USER_MATCH=false`로 측정함. 권장값(`true`)에서는 JWT 발급 흐름이 추가되며 이는 현 부하 스크립트가 모델링하지 않음
3. 단일 노드 Docker Compose 환경. 분산 환경의 cold connection, cross-region latency, DB 연결 풀 동작 등은 측정 범위 밖
4. PostgreSQL / Redis 자체의 메모리·디스크 한계는 시나리오 길이(최대 3분 20초)로는 의미 있게 드러나지 않음