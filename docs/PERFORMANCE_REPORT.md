# 성능 보고서

이 문서는 현재 저장소에 포함된 k6 시나리오와 관찰 지점을 정리한다.  
중요한 점은, 최신 settlement 흐름으로 스크립트는 갱신했지만 실제 수치 측정은 다시 수행해야 한다는 점이다.

## 포함된 부하 테스트 스크립트

- [baseline.js](C:/Users/dosac/projects/PeakPass/load-test/baseline.js)
- [spike.js](C:/Users/dosac/projects/PeakPass/load-test/spike.js)
- [sustained.js](C:/Users/dosac/projects/PeakPass/load-test/sustained.js)
- [payment-callback.js](C:/Users/dosac/projects/PeakPass/load-test/payment-callback.js)

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
- event detail spike 이후 recovery가 느림
- reservation 부하에서 429 없이 DB 에러가 먼저 늘어남
- callback 재시도에서 새 티켓이 추가 생성됨

## 현재 메모

- 스크립트는 현재 API 구조와 settlement 이후 발급 흐름을 반영함
- 최신 수치 측정과 해석은 별도 실행 후 다시 채워야 함
