# 성능 보고서

이 문서는 현재 저장소에 포함된 k6 시나리오, 관찰 지점, 그리고 commit된 측정 결과를 정리합니다.

측정은 세 묶음이고 서로 조건이 다릅니다. 한 묶음의 수치를 다른 묶음과 비교하지 않습니다.

| 묶음 | 시기 | 무엇을 쟀나 | 어디에 있나 |
|---|---|---|---|
| A/B/C 비교 (P8) | 2026-10-08–09 | 같은 도착 조건에서 대기열 없음 / 대기열 + fixed polling / 대기열 + adaptive polling | 아래 "입장 제어 A/B/C 비교" |
| 쓰기 기준선 (P2) | 2026-10-01–02 | 대기열이 없는 구매 경로의 도착률별 동작 | [FLASH_SALE_BASELINE.md](./FLASH_SALE_BASELINE.md) |
| micro-benchmark | 2026-06-03 | 조회, rate limit, webhook 재시도를 시나리오별로 | 아래 "micro-benchmark" 이하 |

모두 로컬 Docker 환경의 합성 부하입니다. 운영 성과가 아닙니다.

## 입장 제어 A/B/C 비교 (P8, 2026-10-08–09)

같은 commit, 같은 Compose 파일, 같은 도착 조건에서 이벤트의 보호 여부와 polling 방식만 바꿔 세 arm을 3회씩 측정했습니다. 프로토콜과 전체 표는 [ISSUE_17_VALIDATION.md](./ISSUE_17_VALIDATION.md), 지표 정의는 [FLASH_SALE_EVIDENCE.md](./FLASH_SALE_EVIDENCE.md), 원본은 `load-test/results/flash-sale-abc-v3/index.json`에 있습니다.

### 조건

| 항목 | 값 |
|---|---|
| 측정 commit | `6f9568f780219ea8e28e026072c448a38e8e069b` |
| 도착 | 초당 50명 × 20초, 구매자 1,000명. 처음 5초의 250명은 warmup, 나머지 750명이 측정 cohort |
| 발생기 | k6, VU 1,000, drain 900초(horizon 920초). 구매자 하나가 페이지의 polling controller를 그대로 실행 |
| 재고와 여정 | 2,000석, 수량 2, 예약 경로와 직접 checkout 경로를 번갈아 |
| profile | `admission-v1-seed`: 초당 승격 R 2, batch 2, 동시 입장 C 8, 입장 TTL 30초 |
| 환경 | 로컬 host 한 대. 앱 1개(1 CPU / 512 MiB), PostgreSQL 16(1 CPU / 512 MiB), Redis 7(0.5 CPU / 256 MiB) |
| 실행 | 정식 9회(A/B/C × 3)와 숨김 탭 20% 층 관측 2회. 11회 모두 첫 시도에 valid |

### 결과 (3회 중앙값 [최소–최대])

| 지표 (분모) | A 대기열 없음 | B fixed polling | C adaptive polling |
|---|---|---|---|
| 판정 | valid-overload ×3 | valid-queue ×3 | valid-queue ×3 |
| 결제 완료 (cohort 750명) | 16.00% [14.67–19.73] | 100% | 100% |
| 구매 시도 실패율 (cohort의 시도) | 61.75% [59.32–62.34] | 0.32% [0.21–0.37] | 0% (0/1,875 ×3) |
| 500 `INTERNAL_ERROR` 응답 수 (전체 시도) | 1,975 [1,907–1,977] | 0 [0–1] | 0 |
| 503 응답 수 (전체 시도) | 0 | 15 [10–26] | 1 [0–1] |
| 인지 뒤 paid p99 (cohort의 결제자. B·C는 controller가 입장을 인지한 시각→결제 완료. A는 대기열이 없어 도착→결제 완료이며 아래 p99 행과 같은 값) | 2,362ms [1,353–3,024] | 804ms [780–941] | 134ms [131–136] |
| 도착→결제 완료 시간 p50 (cohort의 결제자) | 1.1초 [0.4–1.7] | 503.8초 [503.5–504.5] | 306.8초 [306.3–307.1] |
| 도착→결제 완료 시간 p99 (cohort의 결제자) | 2.4초 [1.4–3.0] | 711.1초 [710.2–711.1] | 485.9초 [485.7–486.4] |
| 승격 달성률 (전체 1,000명의 대기열. 대기자가 있는 동안의 승격 수 ÷ R이 허용한 수. 사람 수의 비율이 아님) | – | 67.92% [67.92–68.02] | 98.01% [97.98–98.12] |
| 입장 인지 지연의 상한 p95 (전체 1,000명. 승격→발생기 안 controller의 적용, 요청 송신 기준 상한) | – | 2,720ms [2,653–2,723] | 1,002ms [987–1,004] |
| status 요청 수 (전체 1,000명) | – | 249,395 [249,181–249,444] | 55,983 [55,938–56,061] |
| 1초 동안의 status 요청 최대 (전체 1,000명) | – | 971 [958–975] | 232 [222–236] |
| 결제 수 ÷ horizon 920초 (cohort 750명) | 0.130/s [0.120–0.161] | 0.815/s | 0.815/s |

분모는 행마다 괄호에 적었습니다. "cohort"는 warmup 250명을 제외한 측정 cohort 750명이고, "전체"는 warmup을 포함한 1,000명입니다. 시도를 세는 행(구매 시도 실패율, 500·503 응답 수)은 예약·checkout·정산 요청 가운데 하네스가 일부러 보내는 replay를 뺀 것만 셉니다. 결제 완료, 구매 시도 실패율, 인지 뒤 paid, 도착→결제 완료 시간, 결제 수 ÷ horizon이 cohort 값입니다. warmup을 포함한 1,000명 전체로는 A의 결제자가 125명(12.50%) [113–156]이고, C의 구매 시도 실패는 세 run에서 1, 0, 1건(2,501 / 2,500 / 2,501건 중)입니다. 500·503 응답 수, 승격 달성률, 입장 인지 지연, status 요청 수와 그 1초 최대는 전체의 값입니다.

11회 모두 최종 SQL 검사가 0행이고, 원장과 Redis가 일치하며, 어느 1초에도 승격이 R을 넘지 않았습니다.

### 해석

- **A는 이 조건에서 과부하입니다.** 측정 cohort의 16.00%만 결제했고 나머지는 500으로 끝났습니다. A의 도착→결제 완료 시간 1.1초는 결제에 성공한 소수의 값입니다.
- **대기열은 실패를 대기로 바꿨습니다.** B와 C는 cohort 전원이 결제했습니다. 대신 R 2/s로 1,000명을 받으려면 최소 500초가 걸리고, cohort의 도착→결제 완료 시간 중앙값이 C 306.8초, B 503.8초입니다. 이 값은 대기열에서 기다린 시간에 입장 인지 지연과 구매·정산 시간을 더한 것입니다.
- **대기열이 처리량을 늘린 것은 아닙니다.** B와 C의 cohort 결제 수 ÷ horizon은 0.815/s로 같습니다. 이 값은 "750명이 920초 안에 모두 결제했다"는 뜻일 뿐이고 두 arm을 구분하지 못합니다.
- **B와 C의 차이는 polling 방식 하나입니다.** fixed polling의 status 요청이 같은 1 CPU 인스턴스의 scheduler를 늦춘 것으로 읽습니다(승격 달성률 67.92% 대 98.01%). tick 간격 자체는 재지 않았습니다.
- **B의 503**(전체 시도 기준 15건 [10–26])은 입장 필드가 있는 구매가 직렬화 재시도를 다 쓰고 받은 응답입니다([#27](https://github.com/dosacha/PeakPass/issues/27)). controller가 같은 identity로 다시 보냈고 503으로 끝난 구매자는 없습니다. 다시 보낸 요청이 한 번 더 503을 받은 경우가 `p8-b-01`과 `p8-b-02`에서 2건씩 있었고(위 15건, 26건에 포함), 그 구매도 이후 재전송에서 성공했습니다. cohort의 실패 0.32%(중앙값 run `p8-b-01`의 6/1,881)가 응답 코드별로 어떻게 나뉘는지는 index에 없습니다. 그 run에는 전체 시도 기준으로 503 15건과 500 1건이 있었습니다.

### 한계

1. host 한 대, 앱 인스턴스 1개, 도착 조건 1개, arm당 3회입니다. 최소–최대는 신뢰구간이 아닙니다.
2. 입장 인지 지연은 k6 안에서 controller가 기록한 값입니다. 브라우저에서의 입장 인지 지연은 판정하지 않았습니다. 승격 시각은 서버 시계의 값이고, 그것을 알려 준 응답의 서버 시각이 요청 송신과 수신 사이 어느 순간인지는 알 수 없어 지연을 하한과 상한으로 기록하며, 표의 값은 상한입니다(정의는 [RESUME_EVIDENCE.md](./RESUME_EVIDENCE.md)의 "읽는 법").
3. 정식 run은 전원 전면 탭이고 이탈과 취소가 없습니다. 숨김 탭 20%는 층 관측 2회로만 봤고 통계에 넣지 않았습니다.
4. P2 기준선(v2.6)과의 개선·회귀는 판정하지 않았습니다. commit, Redis 설정, VU, drain이 다릅니다.
5. seed profile은 실험 가정이며 운영 권고값이 아닙니다. 분 단위 대기가 받아들일 만한지는 정하지 않았습니다.
6. profile을 고른 pilot의 수치는 조건 선택용이며 결과로 인용하지 않습니다.

남은 항목은 [#34](https://github.com/dosacha/PeakPass/issues/34)에 있습니다. 설계 선택과 운영 절차는 [ADMISSION_DESIGN_AND_OPERATIONS.md](./ADMISSION_DESIGN_AND_OPERATIONS.md)에 있습니다.

## micro-benchmark (2026-06-03)

아래부터 문서 끝까지는 입장 제어 이전에 한 시나리오별 측정입니다. 위 A/B/C 비교와 부하 모델이 다릅니다.

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
- 방어 장치: Redis rate limit, command별 idempotency result cache (event/inventory read-through cache는 미구현)

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

`load-test/sustained.js`는 **단일 `LOAD_TEST_USER_ID`를 다수 VU가 공유하는** micro-benchmark 형태입니다. 같은 user / 같은 event / 같은 tier에 대한 reservation 요청이 다수 VU에서 들어가므로, 측정 결과는 *동일 row에 대한 lock 경합* 시나리오에 가깝습니다. distinct user N명이 같은 event에 몰리는 flash-sale 모델은 이후 P2 기준선과 위 A/B/C 비교에서 측정했습니다.

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
