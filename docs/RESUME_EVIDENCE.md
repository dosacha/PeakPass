# 프로젝트 설명과 불렛의 근거

이력서와 포트폴리오에 쓰는 PeakPass 설명과 불렛 3개, 그리고 각 문장이 기대는 근거를 적는다. 근거가 바뀌면(run, 계약, 코드) 해당 문장을 다시 확인한다. 이력서 파일 자체는 이 저장소에 두지 않는다.

기준: 수치는 측정 commit `6f9568f780219ea8e28e026072c448a38e8e069b`(main `5529898`로 병합)의 코드로 2026-10-08–09에 잰 것이다. 그 뒤 제품 코드는 2026-10-12에 바뀌었다: 인코딩된 경로에도 rate limit·webhook 서명·멱등성 미들웨어가 적용되게 한 수정, 예약·주문 조회를 구매 한도에서 뺀 것, 운영 시작 검사 강화, 입력 오류의 4xx 응답, GraphQL의 예상하지 못한 오류 메시지 가리기, 주석 정리와 서식. 정적 검토로는 측정에 쓴 요청 경로의 동작이 달라지지 않지만, 이 변경 뒤에 다시 측정하지는 않았다.

## 프로젝트 설명

> 짧은 시간에 구매자가 몰리는 이벤트의 티켓 예약·결제 백엔드입니다. 예약, 결제 전환, 외부 webhook 정산이 같은 재고와 주문을 바꾸는 상황에서 PostgreSQL transaction과 제약으로 정합성을 지키고, Redis 대기열과 입장량 제한, 적응형 polling으로 구매 경로의 유입을 제어했습니다. 통합 테스트와 k6 부하 비교로 검증했습니다.

## 불렛

1. 초당 50명이 20초 동안 몰리는 조건(1,000명, warmup 250명을 제외한 측정 cohort 750명 기준)에서, SERIALIZABLE transaction을 최대 3회 시도하는 구매 경로는 직렬화 실패(SQLSTATE 40001)로 시도를 다 쓴 500이 쌓여 cohort의 16.00%만 결제하고 cohort 구매 시도의 61.75%가 실패 → Redis 대기열(Lua 원자 전이)로 초당 승격 수를 2명으로 제한하고 PostgreSQL 소비 원장으로 입장 1건을 구매 1건에 묶어, 재고 권한은 DB에 둔 채 유입만 제어 → 같은 조건에서 적응형 polling을 쓴 대기열은 cohort 750명 전원 결제, cohort의 구매 시도 실패 0%, 대신 cohort의 도착→결제 완료 시간 중앙값 306.8초 (로컬 단일 인스턴스, 3회 중앙값. 초당 50명은 pilot의 세 단계(초당 10·25·50명) 가운데 대기열 없는 경로가 안정적이지 않았던 가장 낮은 단계로 고른 조건이고, 격리 수준을 내리는 대안은 재지 않음)
2. 대기 화면의 polling 방식을 정하려고 같은 대기열에 고정 간격(1초)과 적응형(대기 순번이 먼 사용자는 5초, jitter)을 같은 조건으로 측정 → 고정 간격은 구매자 1,000명의 status 요청 249,395건이 승격 scheduler와 같은 1 CPU 인스턴스에 몰려, 초당 승격 한도(R) 대비 승격 달성률 67.92%, 입장 인지 지연 상한 p95 2,720ms → 적응형은 요청 55,983건, 승격 달성률 98.01%, 인지 지연 상한 p95 1,002ms(여기까지 1,000명 전체 기준), warmup 250명을 제외한 측정 cohort 750명의 도착→결제 완료 시간 중앙값 503.8초 대 306.8초 → 적응형을 채택 (부하 발생기 안의 polling controller 기준, 3회 중앙값)
3. 같은 결제의 settlement webhook이 서로 다른 Idempotency-Key로 동시에 들어오는 상황 → 주문 행 잠금(`FOR UPDATE`)으로 한 번에 하나만 처리하고, 잠금을 얻은 요청은 주문이 이미 `paid`면 기존 티켓을 그대로 반환(기다리다 직렬화 실패한 요청은 재시도해 같은 확인을 거침). `provider_transaction_id` partial UNIQUE는 이 경로를 벗어난 중복을 막는 마지막 방어선 → 5건을 동시에 보내도 티켓 1건, 정산 기록 1건만 생성됨을 route 단위 통합 테스트로 고정

## 근거

### 불렛 1과 2 (A/B/C 부하 비교)

공통 조건: 측정 commit `6f9568f780219ea8e28e026072c448a38e8e069b`, 초당 50명 × 20초(1,000명, 측정 cohort 750명), k6 VU 1,000, drain 900초, profile `admission-v1-seed`(R 2, batch 2, C 8), 앱 인스턴스 1개(1 CPU / 512 MiB), 로컬 host 한 대. arm은 비교한 조건 하나를 말한다(A 대기열 없음, B 대기열과 고정 간격 polling, C 같은 대기열과 적응형 polling). arm당 3회이고 9회 모두 valid다. 값은 `load-test/results/flash-sale-abc-v3/index.json`의 `runs[].analysis`에 있고, 아래는 arm별 3회의 중앙값이다.

| 문장의 값 | 필드 | arm | 3회 값 | 중앙값이 나온 run |
| --- | --- | --- | --- | --- |
| 16.00% (120/750) | `criteria.completionFraction`, `cohort.confirmedPaid` | A | 148, 120, 110 / 750 | `p8-a-02` |
| 61.75% (1,453/2,353) | `purchase.measuredCohort` | A | 59.32%, 61.75%, 62.34% | `p8-a-02` |
| 750명 전원 | `cohort.confirmedPaid` | C | 750, 750, 750 | 세 run 모두 |
| 실패 0% (0/1,875) | `purchase.measuredCohort` | C | 0, 0, 0 | 세 run 모두 |
| 306.8초 | `cohort.paidJourneyMs.median` | C | 307.1, 306.8, 306.3초 | `p8-c-02` |
| 503.8초 | `cohort.paidJourneyMs.median` | B | 503.5, 504.5, 503.8초 | `p8-b-03` |
| 249,395건 | `polling.statusRequests` | B | 249,181, 249,444, 249,395 | `p8-b-03` |
| 55,983건 | `polling.statusRequests` | C | 56,061, 55,938, 55,983 | `p8-c-03` |
| 67.92% | `criteria.promotionAchievement` | B | 68.02%, 67.92%, 67.92% | `p8-b-03` |
| 98.01% | `criteria.promotionAchievement` | C | 98.12%, 98.01%, 97.98% | `p8-c-02` |
| 2,720ms | `recognition.foreground.upperMs.p95` | B | 2,720, 2,723, 2,653ms | `p8-b-01` |
| 1,002ms | `recognition.foreground.upperMs.p95` | C | 987, 1,002, 1,004ms | `p8-c-02` |

읽는 법:

- 중앙값은 지표마다 따로 구했다. 한 문장의 값들이 같은 run에서 나온 것이 아니다.
- 분모가 둘이다. 결제 완료, 구매 시도 실패율, 도착→결제 완료 시간(`cohort.*`, `purchase.measuredCohort`)은 도착한 1,000명 중 처음 5초의 warmup 250명을 제외한 측정 cohort 750명의 값이다. 입장 인지 지연과 status 요청 수는 1,000명 전체의 값이고, 승격 달성률은 그 1,000명이 만든 대기열에서 잰 값이다.
- 승격 달성률은 사람 수의 비율이 아니다. 대기자가 있던 시간 동안의 실제 승격 수를 R이 허용한 수로 나눈 값이다(`queue.promotionsInBacklog ÷ (R × queue.backlogSeconds)`. 예: `p8-b-03`은 996 ÷ (2 × 733.183초) = 67.92%). 1,000명은 여섯 run 모두 전원 승격됐다(`admission.promoted`).
- 불렛의 "도착→결제 완료 시간"은 `cohort.paidJourneyMs`로, 도착부터 paid까지 전부다. 대기열에서 기다린 시간에 입장 인지 지연과 구매·정산 시간이 더해진 값이다. 대기열 안에서만 기다린 시간(등록→승격, `admission.queueWaitMs`, 1,000명)은 다른 필드이고 값도 다르다.
- 1,000명 전체로 보면 값이 다르다. A의 결제자는 `all.httpPaid` 156, 125, 113명(중앙값 125명, 12.50%)이고, C의 구매 시도 실패는 `purchase.all.failures` 1, 0, 1건(2,501 / 2,500 / 2,501건 중)이다. A의 구매 시도 실패율도 전체로는 `purchase.all` 61.52%, 63.51%, 64.17%(중앙값 63.51%)다. 불렛에서 "cohort 기준"을 빼면 16.00%, 61.75%, 0%는 틀린 문장이 된다.
- 입장 인지 지연은 승격부터 controller가 그것을 화면 상태에 적용할 때까지의 시간이다. 승격 시각은 서버 시계의 값이고, 그것을 알려 준 응답이 요청을 보낸 때와 받은 때 사이 어느 순간의 서버 시각을 담았는지는 알 수 없다. 그래서 지연을 한 값이 아니라 하한(lower, 응답을 받은 때 기준)과 상한(upper, 요청을 보낸 때 기준)으로 기록한다(`frontend/admission-polling.js`의 `lowerMs`, `upperMs`). 불렛의 값은 그 상한의 p95(`recognition.foreground.upperMs.p95`)다. 하한의 p95는 arm B 1,788 / 1,793 / 1,781ms, arm C 984 / 998 / 999ms다.
- 불렛 2는 요청 수와 승격 달성률을 나란히 적을 뿐 인과를 단정하지 않는다. 조회 부하가 scheduler를 늦췄다는 것은 두 arm의 차이가 polling 방식 하나라는 데서 나온 추정이고, tick 간격은 재지 않았다.
- 불렛 1의 결과(전원 결제, 실패 0%, 306.8초)는 적응형 polling을 쓴 arm C의 값이다. 같은 대기열에 fixed polling을 쓴 arm B도 cohort 750명이 전원 결제했지만 cohort의 구매 시도 실패는 0.32%, 도착→결제 완료 시간 중앙값은 503.8초다.
- 불렛 1의 16.00%가 서 있는 조건은 넷이다. 이 가운데 하나라도 빼면 문장이 틀려진다.
  - 원인: 500은 SERIALIZABLE transaction이 직렬화 실패로 3회의 시도(첫 시도와 재시도 2회, `src/infra/postgres/client.ts`)를 다 쓴 응답이다. arm A 세 run에서 예약된 재시도 4,405 / 4,495 / 4,484건이 모두 SQLSTATE 40001이었다(ZIP의 `app-metrics.json`). 같은 좌석 차감을 하는 입장 필드 없는 예약은 READ COMMITTED이고 세 run 모두 500건이 전부 성공했다. 500 하나하나의 원인이 담긴 앱 로그는 보관본에 없다.
  - 재지 않은 대안: checkout과 정산을 READ COMMITTED로 내리거나 시도 횟수를 늘린 arm A는 측정하지 않았다. 그래서 "대기열이 없으면 16%"가 아니라 "이 격리 수준과 시도 횟수에서 16%"다.
  - 도착률: 초당 50명은 조건을 고르는 pilot의 세 단계(초당 10·25·50명, 각 1회) 가운데 arm A가 안정적이지 않았던 가장 낮은 단계다. 그 pilot에서 arm A는 초당 10명에서 300/300, 초당 25명에서 749/750을 결제했다. "대기열 없는 경로가 불안정해지는 가장 낮은 도착률"이라고 일반화하지 않는다. 앞선 쓰기 기준선에서는 초당 25명이 3회 중 2회 과부하였다.
  - 재전송: arm A의 구매자는 실패한 checkout과 정산 webhook을 100ms 뒤 1회만 다시 보내고, 예약은 다시 보내지 않는다. arm B·C의 첫 구매 요청은 controller가 최대 4회 더 보낸다. arm A의 구매자 1,000명 가운데 주문이 만들어진 것은 537 / 511 / 490명이고, 그중 381 / 386 / 377명은 정산 webhook이 두 번 다 500을 받아 주문이 pending으로 남았다(`sqlCounts`, warmup 포함 1,000명 기준). 실제 결제사처럼 webhook을 더 오래 다시 보냈을 때의 결제율은 재지 않았다. arm C의 전원 결제는 재전송에 기대지 않았다(첫 구매 요청 실패 1, 0, 1건).
- 불렛 1의 "초당 승격 수를 2명으로 제한"에서 2(R)는 측정으로 찾은 값이 아니라 처음에 정한 가정이다. pilot에서 R을 올린 후보는 구매 시도 실패율 기준을 맞추지 못해 탈락했다. 동시 입장 상한(C 8)은 정식 run에서 닿지 않았으므로(표본 최대 3–5) 불렛에 넣지 않았다.
- 불렛 2의 두 방식은 측정 전에 계약 §7에 함께 정해 둔 것이고, 고정 간격은 비교 기준이다. 측정하다가 문제를 발견해 바꾼 것이 아니다.
- 증거 종류는 실제 HTTP, PostgreSQL, Redis다. 구매자는 k6 iteration이고 페이지의 polling controller(`frontend/admission-polling.js`)를 그대로 실행했다. 브라우저는 아니다.
- 구현 근거: 대기열과 승격은 `src/infra/redis/admission.ts`와 `src/core/services/admission.service.ts`, 소비 원장은 `src/core/services/admission-consumption.ts`와 migration 013, polling 간격은 계약 §7과 `frontend/admission-polling.js`.
- 프로토콜, 기준, 표 전체는 [ISSUE_17_VALIDATION.md](records/ISSUE_17_VALIDATION.md)의 "Formal protocol"과 "Formal results"에 있다.

### 불렛 3 (통합 테스트)

- `src/tests/integration/route-contract.test.ts`의 T04: 서로 다른 Idempotency-Key로 settlement 5건을 동시에 보낸다. 응답 5건이 모두 200이고 `duplicate: false`가 1건, 티켓 1건, provider에 연결된 정산 기록 1건, 주문 상태 `paid`를 확인한다.
- `src/tests/integration/webhook-idempotency.test.ts`의 "handles concurrent duplicate settlement webhooks idempotently": 같은 조건을 service 단위로 확인한다.
- 구현: `src/core/services/payment-webhook.service.ts`. 정산은 주문 행을 `FOR UPDATE`로 잠근 뒤 주문 상태를 본다. 이미 `paid`면 정산 기록과 티켓을 새로 만들지 않고 기존 티켓을 반환한다(받은 key는 `payment_callback_keys`에 남는다). SERIALIZABLE에서 잠금을 기다리던 요청은 앞선 요청이 commit하면 직렬화 실패로 끝나고, 재시도에서 `paid`를 보게 된다. `payment_records`의 `provider_transaction_id` partial UNIQUE와 `ON CONFLICT DO NOTHING`은 그 뒤에 있는 방어선이다.
- 증거 종류는 실제 PostgreSQL과 Redis를 쓰는 통합 테스트다. CI의 "Run integration tests" 단계에서 돈다. 부하 측정이 아니며, 5는 테스트가 보낸 건수다.
- "정산 기록 1건"은 provider에 연결된 `payment_records` 행을 말한다. checkout이 만든 pending 기록은 따로 있고, 받은 Idempotency-Key는 key마다 `payment_callback_keys`에 남는다. 그래서 "DB write가 줄었다"고 쓰지 않는다.

## 쓰지 않는 표현

- 대기열로 처리량이 늘었다, TPS가 몇 배가 됐다. fixed와 adaptive arm의 cohort 결제 수 ÷ horizon은 같다(0.815/s). 대기열 없는 arm과 비교해 달라진 것은 결제하지 못한 구매자가 없어진 것이고, fixed와 adaptive 사이에서 달라진 것은 처리량이 아니라 대기 쪽 값이다: 도착→결제 완료 시간과 승격 달성률, 그리고 status 요청 수, 입장 인지 지연, cohort 구매 시도 실패(0.32% 대 0%).
- 운영 환경, 실서비스, 실사용자. 모두 로컬 합성 부하다.
- 브라우저 기준 입장 인지 지연, 2초 SLO 달성. 입장 인지 지연은 부하 발생기 안에서 잰 값이고 2초는 실험 목표였다.
- 쓰기 기준선(v2.6) 대비 개선. 조건이 달라 판정하지 않았다.
- 최대 처리량, 권장 설정. seed 값(R 2, C 8)은 실험 가정이다.
- 신뢰구간, 오차 범위. 3회의 최소–최대가 있을 뿐이다.
- pilot 수치.
- 장애 내성을 검증했다는 일반화. 장애 검증은 로컬에서 한 정해진 시나리오의 동작 증거다.
- 조건 없는 "대기열이 없으면 16%만 결제된다". 위 "읽는 법"의 네 조건이 붙는다.
- partial UNIQUE로 동시 중복 정산을 직렬화했다. 직렬화하는 것은 주문 행 잠금이다.
- polling 문제를 발견해 적응형으로 바꿨다. 두 방식은 처음부터 비교 대상이었다.
- scheduler tick 지연을 측정했다. 승격 달성률에서 추정한 것이다.

## 불렛에 넣지 않은 수치

| 수치 | 넣지 않은 이유 |
| --- | --- |
| 2026-06-03 micro-benchmark의 RPS와 p95 | 한 사용자가 한 행을 두드린 부하다. 병목이나 불변식을 말해 주지 않는다 |
| rate limit 시나리오의 99%대 차단율 | 입력(한도보다 훨씬 많은 요청)이 정한 비율이다 |
| 테스트 개수, 리뷰 회차, run 수 | 결과가 아니라 작업량이다 |
| R 2, C 8, TTL 30초 | 설정값이다. 근거 조건으로만 적는다 |
| cohort 결제 수 ÷ horizon 0.815/s | 두 대기열 arm이 같아 아무것도 구분하지 않는다 |
| 입장 인지 뒤 paid p99 804ms(arm B, fixed) → 134ms(arm C, adaptive). controller가 입장을 인지한 시각부터 paid까지이며 승격 시각부터가 아니다. 측정 cohort 750명, 3회 중앙값 | 유효한 값이지만 불렛 2가 이미 네 값을 담고 있다. [성능 보고서](PERFORMANCE_REPORT.md)에 있다 |
