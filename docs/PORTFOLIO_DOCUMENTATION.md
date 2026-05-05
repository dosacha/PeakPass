# 포트폴리오 문서 가이드

이 문서는 PeakPass를 포트폴리오로 보여줄 때 어떤 문서를 먼저 읽히고, 어떤 메시지로 설명할지 정리한다.

## 핵심 메시지

PeakPass는 실시간 티켓 발급 서비스의 핵심 흐름을 단일 백엔드에서 재현한 학습용 프로젝트다. 강조할 지점은 화면이나 CRUD가 아니라 정합성, 멱등성, 결제 확정 이후 발급, Redis 보조 계층, GraphQL read-side 분리다.

## 먼저 보여줄 문서

1. `README.md`
2. `docs/CASE_STUDY.md`
3. `docs/ARCHITECTURE_DIAGRAMS.md`
4. `docs/TRANSACTION_CONSISTENCY.md`
5. `docs/REDIS_STRATEGY.md`
6. `docs/GRAPHQL_RATIONALE.md`
7. `docs/PERFORMANCE_REPORT.md`

## 문서별 설명 포인트

### README.md

프로젝트의 전체 맥락을 보여주는 문서다. 기술 스택, 데모 구조, 한계, REST write-side와 GraphQL read-side 분리, PostgreSQL과 Redis 역할, 로컬 실행 방법을 한 번에 설명한다.

강조할 메시지:

- 개인 학습 프로젝트임을 솔직하게 밝힘
- 티켓팅 도메인의 정합성 문제를 코드로 설명하는 것이 목표
- checkout은 `pending` 주문만 만들고 티켓은 settlement 이후 발급
- live demo의 webhook 시뮬레이션이 HMAC secret 부재로 401이 나는 것은 정상 동작

### docs/CASE_STUDY.md

문제, 목표, 해결 방식, 결과를 면접관이 빠르게 이해할 수 있게 정리한 문서다. 포트폴리오 설명을 시작할 때 가장 좋은 보조 자료다.

강조할 메시지:

- 같은 이벤트에 조회와 예약이 몰리는 상황을 다룸
- 중복 결제 callback과 클라이언트 재시도를 고려함
- PostgreSQL을 source of truth로 두고 Redis를 보조 계층으로 둠

### docs/ARCHITECTURE_DIAGRAMS.md

Fastify, REST, GraphQL, PostgreSQL, Redis 흐름을 다이어그램으로 보여주는 문서다. 말로 설명하기 어려운 흐름을 시각화할 때 쓴다.

강조할 메시지:

- REST는 명령 API, GraphQL은 조회 API
- middleware에서 인증, rate limit, idempotency를 처리
- reservation, checkout, settlement webhook의 시퀀스가 분리되어 있음

### docs/TRANSACTION_CONSISTENCY.md

가장 중요한 정합성 문서다. oversell 방지, idempotency, duplicate webhook 방어, DB 제약을 설명한다.

강조할 메시지:

- `SERIALIZABLE` 트랜잭션과 `FOR UPDATE`를 사용
- `orders.idempotency_key`, `tickets.ticket_number`, `payment_records.provider_transaction_id` 제약을 활용
- Redis lock이 아니라 PostgreSQL 행 잠금이 최종 방어선

### docs/REDIS_STRATEGY.md

Redis를 cache 이상의 운영 보조 계층으로 사용했다는 점을 설명한다.

강조할 메시지:

- reservation TTL hold
- sliding window rate limit
- idempotency result cache
- event와 inventory cache
- Redis 장애 시에도 DB 정합성은 유지

### docs/GRAPHQL_RATIONALE.md

GraphQL을 왜 read-side에만 두었는지 설명하는 문서다.

강조할 메시지:

- write-side는 REST로 유지해 트랜잭션과 멱등성 경계를 선명하게 함
- read-side는 GraphQL로 overfetching과 N+1 문제를 줄임
- query complexity plugin이 resolver 진입 전 비용을 제한

### docs/PERFORMANCE_REPORT.md

부하 테스트 결과를 정량적으로 보여주는 문서다.

강조할 메시지:

- read spike와 baseline 결과가 commit되어 있음
- reservation sustained에서 완전한 reservation 흐름을 측정함
- rate limit on 비교 시나리오로 fail-fast 거부 성능을 확인함
- payment-callback 결과는 HMAC header 반영 후 추가 예정

## 코드와 함께 열면 좋은 파일

- `src/main.ts`: 부팅과 graceful shutdown
- `src/api/app.ts`: Fastify 조립, raw body parser, middleware 연결
- `src/api/rest/reservations.ts`: reservation API
- `src/api/rest/checkouts.ts`: checkout transaction 진입점
- `src/api/rest/payments.ts`: settlement webhook 진입점
- `src/core/services/reservation.service.ts`: 좌석 hold, release, expire, convert
- `src/core/services/checkout.service.ts`: 주문 생성, settlement 처리, 티켓 발급
- `src/infra/postgres/client.ts`: SERIALIZABLE retry
- `src/infra/redis/commands.ts`: TTL, rate limit, idempotency, cache
- `src/api/graphql/server.ts`: Apollo server와 complexity plugin 연결
- `src/api/graphql/resolvers.ts`: read-side resolver

## 보여주면 좋은 검증 자료

- `src/tests/unit/graphql-complexity.test.ts`
- `src/tests/unit/webhook-signature.test.ts`
- `src/tests/integration/concurrency.test.ts`
- `src/tests/integration/redis.test.ts`
- `load-test/results/baseline-2026-05-05-1933.json`
- `load-test/results/spike-2026-05-05-1915.json`
- `load-test/results/sustained-reservation-2026-05-05-2208.json`
- `load-test/results/sustained-2026-05-05-2119.json`

## 솔직하게 말해야 할 한계

- 실제 장기 운영 트래픽으로 검증된 서비스는 아님
- `POST /reservations`, `POST /checkouts`는 현재 body의 `userId`와 인증 subject 대조를 선택적으로 강제하는 구조라 운영에서는 인증 주체 기반으로 더 좁혀야 함
- payment callback 부하 테스트 결과는 HMAC timestamp header 반영 후 추가 예정
- Terraform 파일은 존재하지만 실제 AWS apply는 별도 검증 대상

## 포트폴리오에서 피해야 할 표현

- 완전한 운영 서비스라고 말하지 않기
- Redis가 좌석 정합성을 보장한다고 말하지 않기
- checkout 직후 티켓을 발급한다고 말하지 않기
- GraphQL이 모든 API를 대체한다고 말하지 않기

## 추천 설명 순서

1. README로 프로젝트 목표와 한계를 먼저 말한다.
2. CASE_STUDY로 왜 이 문제가 의미 있는지 설명한다.
3. ARCHITECTURE_DIAGRAMS로 흐름을 보여준다.
4. TRANSACTION_CONSISTENCY와 코드 파일을 함께 열어 정합성을 설명한다.
5. PERFORMANCE_REPORT로 측정 결과를 보여준다.
6. 남은 과제를 솔직하게 정리한다.