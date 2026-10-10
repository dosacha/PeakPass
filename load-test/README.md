# 부하 테스트 가이드

PeakPass의 k6 기반 부하 테스트 스크립트와 실행 방법입니다. 시나리오의 설계 기준은 [docs/LOAD_TEST_STRATEGY.md](../docs/LOAD_TEST_STRATEGY.md), 측정 결과는 [docs/PERFORMANCE_REPORT.md](../docs/PERFORMANCE_REPORT.md)에 있습니다.

모든 스크립트는 로컬 환경을 대상으로 합니다. 공개 데모 서버를 포함해 자신이 운영하지 않는 주소에는 실행하지 마세요.

## 설치

### k6 설치
```bash
# macOS (Homebrew)
brew install k6

# Windows (Chocolatey)
choco install k6

# Windows (winget)
winget install k6.k6
```

### 프로젝트 의존성
```bash
npm install
```

## 스크립트 두 종류

| 종류 | 파일 | 환경 |
| --- | --- | --- |
| 시나리오별 micro-benchmark | `baseline.js`, `spike.js`, `sustained.js`, `payment-callback.js`, `graphql-rate-limit.js`, `reservation-rate-limit.js` | 직접 띄운 `docker compose` 앱 |
| flash-sale 하네스 | `flash-sale-fixture.mjs`, `flash-sale.js`, `flash-sale-analysis.mjs`, `flash-sale-monitor-replay.mts`, 검사 `flash-sale-check.mjs` | 하네스가 실행마다 띄우고 지우는 전용 Compose |

## micro-benchmark

순수 성능 측정과 rate limit 동작 측정은 분리해서 실행합니다.

- 순수 성능: `baseline.js`, `spike.js`
  - 목적: 정상 200 응답의 p95/p99 확인
  - 테스트 환경에서 rate limit을 충분히 크게 설정합니다(`docker-compose.perf.yml`).
- Rate limit 측정: `graphql-rate-limit.js`, `reservation-rate-limit.js`
  - 목적: 429 발생 여부, 차단 비율, 차단 시 latency 확인
  - 기본 rate limit 설정을 유지합니다.
- 예약 경합/방어 흐름: `sustained.js`, `payment-callback.js`
  - 목적: 같은 행에 대한 예약 경합, 중복 webhook, idempotency 방어 확인

순수 성능 측정용 예시:

```bash
docker compose -f docker-compose.yml -f docker-compose.perf.yml up -d --force-recreate app
docker compose exec redis redis-cli FLUSHDB
```

이 모드는 rate limit을 높이고, dev watcher 대신 빌드된 `dist/main.js`를 실행합니다.

Rate limit 측정용 예시:

```bash
docker compose up -d --force-recreate app
docker compose exec redis redis-cli FLUSHDB

npm run load-test:rate-limit:graphql

BASE_URL=http://localhost:3000 \
LOAD_TEST_USER_ID=USER_ID \
LOAD_TEST_EVENT_ID=EVENT_ID \
LOAD_TEST_TIER_ID=TIER_ID \
npm run load-test:rate-limit:reservations
```

아래 부하 프로필과 threshold는 각 스크립트의 `options`에 있는 값입니다. threshold는 k6가 실행을 통과로 볼 조건이며, 측정된 결과가 아닙니다.

### 1. Baseline (`baseline.js`)

일반 조회 트래픽의 기준선입니다. 대상은 `/health`, GraphQL `events`, GraphQL `event`입니다.

| 구간 | VU |
| --- | --- |
| 1분 | 10까지 |
| 3분 | 50까지 |
| 5분 | 50 유지 |
| 1분 | 0까지 |

threshold: `browse_latency_ms` p95 < 800ms, p99 < 1500ms, `browse_errors` < 3%.

```bash
npm run load-test:baseline
```

### 2. Spike (`spike.js`)

이벤트 상세 조회가 갑자기 몰릴 때의 tail latency입니다. 대상은 GraphQL `event`입니다.

| 구간 | VU |
| --- | --- |
| 30초 | 10까지 |
| 5초 | 200까지 |
| 30초 | 200 유지 |
| 10초 | 0까지 |

threshold: `event_detail_spike_latency_ms` p95 < 1200ms, p99 < 2000ms, `event_detail_spike_errors` < 5%.

```bash
npm run load-test:spike
```

### 3. Sustained (`sustained.js`)

`POST /reservations`에 대한 예약 부하입니다. 여러 VU가 `LOAD_TEST_USER_ID` 하나를 함께 쓰므로 같은 행에 대한 lock 경합과 rate limit을 보는 시나리오입니다. 서로 다른 구매자가 몰리는 부하는 아래 flash-sale 하네스가 다룹니다.

| 구간 | VU |
| --- | --- |
| 30초 | 20까지 |
| 30초 | 150까지 |
| 2분 | 150 유지 |
| 20초 | 0까지 |

threshold: `flash_sale_reservation_latency_ms` p95 < 1000ms, p99 < 2000ms, `flash_sale_reservation_errors` < 10%.

```bash
npm run load-test:sustained
```

### Payment callback 재실행 확인

`payment-callback.js`는 setup마다 새 주문과 반복 callback 키를 만듭니다.
짝수 iteration은 그 실행의 키를 공유하고 홀수 iteration은 새 키를 사용합니다.
DB/Redis를 유지한 채 재실행해도 각 주문을 별도로 정산할 수 있습니다.
이 스크립트는 JWT/HMAC을 보내지 않으므로 인증을 명시적으로 완화한 전용
데모 환경에서 실행하세요. 순수 정합성 확인 시 rate limit도 충분히 높입니다.

```bash
node --experimental-vm-modules load-test/payment-callback-check.mjs
k6 run --vus 1 --iterations 6 load-test/payment-callback.js
```

API 연결과 `LOAD_TEST_USER_ID`, `LOAD_TEST_EVENT_ID`, `LOAD_TEST_TIER_ID` 설정은
필요합니다. provider transaction ID를 직접 지정하면 재실행마다 새 값으로 바꾸세요.

## flash-sale 하네스

서로 다른 구매자가 정해진 속도로 도착해 예약 → checkout → 정산까지 가는 쓰기 부하를 측정합니다. JWT와 webhook 서명을 실제로 보냅니다. 실행마다 자체 PostgreSQL 16, Redis 7, 현재 코드로 빌드한 production 앱을 `docker-compose.flash-sale.yml`로 띄우고, 끝나면 그 실행의 자원만 지웁니다. 빌드한 이미지(`peakpass:fs-<run id>`)와 결과 폴더는 남습니다. 기존 Compose, `.env`의 연결 설정, 공유 DB는 쓰지 않습니다.

Node 18 이상, Docker Compose v2, k6, `npm ci`가 필요합니다. 저장소 루트에서 실행합니다.

```bash
npm run build
npm run test:flash-sale

# 대기열 없는 기준 여정
npm run load-test:flash-sale -- --run-id my-ample-01

# A/B/C 비교에 쓴 조건 (arm은 a, b, c 중 하나)
npm run load-test:flash-sale -- --run-id my-c-01 --arm c --users 1000 --rate 50 --warmup-seconds 5 --pre-vus 1000 --max-vus 1000 --drain-seconds 900
```

- `--arm a`는 대기열 없음, `b`는 대기열과 fixed polling, `c`는 같은 대기열과 adaptive polling입니다.
- run id는 매번 새로 씁니다. 같은 id의 결과 폴더나 Compose 자원이 있으면 실행을 거부합니다.
- 결과는 `load-test/results/flash-sale/<run id>/`에 생기고 git이 무시합니다. `analysis.json`의 `classification`이 판정입니다.
- 위 A/B/C 조건은 실행 하나의 부하 구간이 최대 920초이고 VU 1,000을 미리 만듭니다. 다른 부하가 없는 host에서 실행하세요.
- `--monitor`는 Redis `MONITOR`를 붙이는 검증 전용 실행이고 `--arm b`에서만 받습니다. Redis를 느리게 하므로 그 실행의 수치는 측정으로 쓰지 않습니다.

입력 전체, 산출 파일, 판정 규칙은 [docs/FLASH_SALE_EVIDENCE.md](../docs/FLASH_SALE_EVIDENCE.md)에 있습니다.

### 저장된 증거

| 폴더 | 내용 |
| --- | --- |
| `results/flash-sale-abc-v3/` | P8 A/B/C 비교. `index.json`(run 46개의 목록, 정식 9회와 층 관측 2회의 분석 전체)과 ZIP 11개 |
| `results/flash-sale-reference/` | P1 하네스의 reference run 증거(`p1-reference-*`) |
| `results/flash-sale-baseline-v261/` | P2 쓰기 기준선의 인덱스(analysis v2.6.1. 수용한 정식 12회와 정식에서 제외한 preflight 2회, run 14개), 정식 run 가운데 `p2-v26-limited-02`·`p2-v26-limited-03`의 ZIP, 재분석·검증 파일. 나머지 정식 run 10회와 preflight 2회의 ZIP은 `flash-sale-baseline-v26/`에 있다 |
| `results/flash-sale-baseline/`, `results/flash-sale-baseline-v24/`–`v26/` | P2 쓰기 기준선의 run별 ZIP과 이전 revision의 기록. 읽는 법은 [docs/FLASH_SALE_BASELINE.md](../docs/FLASH_SALE_BASELINE.md) |

`flash-sale-abc-v3/`의 ZIP 11개에는 `k6-raw.jsonl`과 `app.jsonl`이 없습니다. 두 파일은 크기와 SHA256만 그 폴더의 index(`localOnly`)에 있고, `npm run test:flash-sale`의 검사 하나가 이 폴더의 ZIP을 index와 대조합니다. P1·P2 폴더의 run ZIP에는 두 파일이 들어 있습니다.

## 참고 자료

- [k6 공식 문서](https://k6.io/docs/)
- [k6 API 레퍼런스](https://k6.io/docs/javascript-api/)
- [부하 테스트 가이드](https://k6.io/docs/testing-guides/load-testing/)
