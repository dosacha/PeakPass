# 프로젝트 설명과 불렛의 근거

이력서와 포트폴리오에 쓰는 PeakPass 설명과 불렛 3개, 그리고 각 문장이 기대는 근거를 적는다. 근거가 바뀌면(run, 계약, 코드) 해당 문장을 다시 확인한다. 이력서 파일 자체는 이 저장소에 두지 않는다.

기준: main `5529898`(2026-10-09). 제품 코드·계약·migration은 main `1bb2796`과 같다.

## 프로젝트 설명

> 짧은 시간에 구매자가 몰리는 이벤트의 티켓 예약·결제 백엔드입니다. 예약, 결제 전환, 외부 webhook 정산이 같은 재고와 주문을 바꾸는 상황에서 PostgreSQL transaction과 제약으로 정합성을 지키고, Redis 대기열과 입장량 제한, 적응형 polling으로 구매 경로의 유입을 제어했습니다. 통합 테스트와 k6 부하 비교로 검증했습니다.

## 불렛

1. 초당 50명이 20초 동안 몰리는 조건(1,000명, warmup 250명을 제외한 측정 cohort 750명 기준)에서 대기열 없는 구매 경로는 cohort의 16.00%만 결제하고 cohort 구매 시도의 61.75%가 실패하는 과부하 → Redis 대기열(Lua 원자 전이)로 초당 승격 수와 동시 입장 수를 제한하고 PostgreSQL 소비 원장으로 입장 1건을 구매 1건에 묶어, 재고 권한은 DB에 둔 채 유입만 제어 → 같은 조건에서 적응형 polling을 쓴 대기열은 cohort 750명 전원 결제, cohort의 구매 시도 실패 0%, 대신 cohort의 도착→결제 완료 시간 중앙값 306.8초 (로컬 단일 인스턴스, 3회 중앙값)
2. 구매자 1,000명이 대기하며 1초 간격으로 상태를 조회하자 status 요청 249,395건이 승격 scheduler와 같은 1 CPU 인스턴스에 몰렸고, 초당 승격 한도(R) 대비 승격 달성률 67.92%, 입장 인지 지연 상한 p95 2,720ms → 대기 순번이 먼 사용자의 조회 간격을 5초로 늘리고 jitter를 준 적응형 polling으로 변경 → 요청 55,983건, 승격 달성률 98.01%, 인지 지연 상한 p95 1,002ms(여기까지 1,000명 전체 기준), warmup 250명을 제외한 측정 cohort 750명의 도착→결제 완료 시간 중앙값 503.8초 → 306.8초 (부하 발생기 안의 polling controller 기준, 3회 중앙값)
3. 같은 결제의 settlement webhook이 서로 다른 Idempotency-Key로 동시에 들어오는 상황 → 주문 행 잠금과 `provider_transaction_id` partial UNIQUE로 직렬화 → 5건을 동시에 보내도 티켓 1건, 정산 기록 1건만 생성됨을 route 단위 통합 테스트로 고정

## 근거

### 불렛 1과 2 (P8 측정)

공통 조건: 측정 commit `6f9568f780219ea8e28e026072c448a38e8e069b`, 초당 50명 × 20초(1,000명, 측정 cohort 750명), k6 VU 1,000, drain 900초, profile `admission-v1-seed`(R 2, batch 2, C 8), 앱 인스턴스 1개(1 CPU / 512 MiB), 로컬 host 한 대. arm당 3회이고 9회 모두 valid다. 값은 `load-test/results/flash-sale-abc-v3/index.json`의 `runs[].analysis`에 있고, 아래는 arm별 3회의 중앙값이다.

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
- 증거 종류는 실제 HTTP, PostgreSQL, Redis다. 구매자는 k6 iteration이고 페이지의 polling controller(`frontend/admission-polling.js`)를 그대로 실행했다. 브라우저는 아니다.
- 구현 근거: 대기열과 승격은 `src/infra/redis/admission.ts`와 `src/core/services/admission.service.ts`, 소비 원장은 `src/core/services/admission-consumption.ts`와 migration 013, polling 간격은 계약 §7과 `frontend/admission-polling.js`.
- 프로토콜, 기준, 표 전체는 [ISSUE_17_VALIDATION.md](ISSUE_17_VALIDATION.md)의 "Formal protocol"과 "Formal results"에 있다.

### 불렛 3 (통합 테스트)

- `src/tests/integration/route-contract.test.ts`의 T04: 서로 다른 Idempotency-Key로 settlement 5건을 동시에 보낸다. 응답 5건이 모두 200이고 `duplicate: false`가 1건, 티켓 1건, provider에 연결된 정산 기록 1건, 주문 상태 `paid`를 확인한다.
- `src/tests/integration/webhook-idempotency.test.ts`의 "handles concurrent duplicate settlement webhooks idempotently": 같은 조건을 service 단위로 확인한다.
- 구현: `src/core/services/payment-webhook.service.ts`(주문 행 `FOR UPDATE`, `payment_records`의 `provider_transaction_id` partial UNIQUE와 `ON CONFLICT DO NOTHING`).
- 증거 종류는 실제 PostgreSQL과 Redis를 쓰는 통합 테스트다. CI의 "Run integration tests" 단계에서 돈다. 부하 측정이 아니며, 5는 테스트가 보낸 건수다.
- "정산 기록 1건"은 provider에 연결된 `payment_records` 행을 말한다. checkout이 만든 pending 기록은 따로 있고, 받은 Idempotency-Key는 key마다 `payment_callback_keys`에 남는다. 그래서 "DB write가 줄었다"고 쓰지 않는다.

## 쓰지 않는 표현

- 대기열로 처리량이 늘었다, TPS가 몇 배가 됐다. fixed와 adaptive arm의 cohort 결제 수 ÷ horizon은 같다(0.815/s). 대기열 없는 arm과 비교해 달라진 것은 결제하지 못한 구매자가 없어진 것이고, fixed와 adaptive 사이에서 달라진 것은 도착→결제 완료 시간과 승격 달성률이다.
- 운영 환경, 실서비스, 실사용자. 모두 로컬 합성 부하다.
- 브라우저 기준 입장 인지 지연, 2초 SLO 달성. 입장 인지 지연은 부하 발생기 안에서 잰 값이고 2초는 실험 목표였다.
- P2 기준선(v2.6) 대비 개선. 조건이 달라 판정하지 않았다.
- 최대 처리량, 권장 설정. seed 값(R 2, C 8)은 실험 가정이다.
- 신뢰구간, 오차 범위. 3회의 최소–최대가 있을 뿐이다.
- pilot 수치.
- 장애 내성을 검증했다는 일반화. P7은 로컬에서 한 정해진 시나리오의 동작 증거다.
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
