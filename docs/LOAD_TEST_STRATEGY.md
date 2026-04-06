# 부하 테스트 전략

PeakPass는 읽기 트래픽과 쓰기 트래픽의 성격이 다르다.  
그래서 k6 시나리오도 조회, 예약, 결제 webhook 재시도 흐름으로 나눠서 본다.

## 시나리오

### 1. baseline browse traffic

- 목적: 일반 조회 트래픽 기준선 측정
- 대상: `/health`, GraphQL `events`, GraphQL `event`
- 스크립트: [baseline.js](C:/Users/dosac/projects/PeakPass/load-test/baseline.js)

```bash
npm run load-test:baseline
```

### 2. burst event-detail query traffic

- 목적: 특정 이벤트 상세 조회가 갑자기 몰릴 때 응답성 확인
- 대상: GraphQL `event`
- 스크립트: [spike.js](C:/Users/dosac/projects/PeakPass/load-test/spike.js)

```bash
npm run load-test:spike
```

### 3. flash-sale reservation traffic

- 목적: 플래시세일 상황에서 reservation hold API의 응답 시간과 rate limiting 동작 확인
- 대상: `POST /reservations`
- 스크립트: [sustained.js](C:/Users/dosac/projects/PeakPass/load-test/sustained.js)

필수 환경 변수:

- `LOAD_TEST_USER_ID`
- 선택: `LOAD_TEST_EVENT_ID`, `LOAD_TEST_TIER_ID`

```bash
npm run load-test:sustained
```

### 4. duplicate / retry-heavy payment callback traffic

- 목적: 같은 settlement webhook이 여러 번 들어와도 중복 발급이 생기지 않는지 확인
- 대상: `POST /webhooks/payments/settlement`
- 스크립트: [payment-callback.js](C:/Users/dosac/projects/PeakPass/load-test/payment-callback.js)

필수 환경 변수:

- `LOAD_TEST_USER_ID`
- `LOAD_TEST_EVENT_ID`
- `LOAD_TEST_TIER_ID`

```bash
npm run load-test:callbacks
```

## 관찰 지표

- p95, p99 응답 시간
- 에러율
- 429 비율
- duplicate webhook 응답 비율
- DB 연결 수
- Redis hit, miss 변화

## 해석 포인트

- browse 시나리오에서 p95가 안정적이면 read-side cache와 DB 조회가 균형을 유지하는 것으로 본다
- event detail spike에서 tail latency가 급격히 올라가면 hot key cache 전략을 다시 본다
- reservation 부하에서 429가 적절히 발생하면 rate limit이 동작하는 것으로 본다
- payment callback 부하에서 duplicate 응답은 늘 수 있지만 티켓 수가 늘면 안 된다

## 권장 실행 순서

1. baseline
2. spike
3. sustained
4. callbacks
5. 결과 비교와 병목 정리

## 현재 메모

- 스크립트는 현재 REST write-side와 GraphQL read-side 구조에 맞춰 갱신함
- 실제 수치 보고서는 최신 settlement 흐름 기준으로 다시 채워야 함
