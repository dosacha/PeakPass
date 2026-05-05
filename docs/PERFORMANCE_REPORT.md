# 성능 보고서

이 문서는 현재 저장소에 포함된 k6 시나리오, 관찰 지점, 그리고 commit된 측정 결과를 정리한다.

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
- baseline / spike / sustained 결과는 commit으로 고정됨 (아래 측정 결과 참조)
- payment-callback 시나리오는 HMAC `X-Webhook-Timestamp` 서명 패턴 반영 후 결과 추가 예정 (현재 script는 secret 미설정 환경에서만 실행 가능)

## 측정 결과 (2026-05-05, 로컬 Docker Compose 환경)

| 시나리오 | 결과 파일 | RPS | p95 latency | 에러율 |
|---|---|---|---|---|
| read spike (200 VU) | `load-test/results/spike-2026-05-05-1915.json` | 648.9 | 15.6 ms | 0% |
| read baseline (50 VU 10분) | `load-test/results/baseline-2026-05-05-1933.json` | 107.4 | 18.5 ms | 0% |
| write reservation sustained (150 VU 3분 20초) | `load-test/results/sustained-reservation-2026-05-05-2208.json` | 258.4 | 486 ms | 0% (51,685건 모두 성공) |
| rate limit on, 동일 부하 | `load-test/results/sustained-2026-05-05-2119.json` | 1,059.6 | 6.0 ms | 100% rate-limited (212,028건 거부) |

해석:
- read 경로는 200 VU spike에서도 p95 16ms로 흔들리지 않음 (cache hit + 단순 SELECT)
- write 경로는 SERIALIZABLE + FOR UPDATE + Redis hold를 모두 거치는 *완전한* reservation 흐름에서 258 RPS, 0% 에러
- rate limit on 비교 시나리오에서 1,060 RPS의 사실상 100%가 fail-fast 거부됨 (p95 6ms) → fail-closed 정책의 정량 검증
- payment-callback 시나리오는 결과 미고정 (HMAC header 반영 후 추가 예정)
