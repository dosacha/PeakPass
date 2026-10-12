# 애플리케이션 안정성

이 문서는 현재 코드에 들어가 있는 애플리케이션 안정성 관련 기능과 하지 않은 것을 정리합니다.

## 현재 구현된 항목

### 상태 확인 엔드포인트

- `GET /health`
- `GET /ready`

관련 파일:

- [health.ts](../src/api/health.ts)

동작:

- `/health`: 프로세스 생존 확인
- `/ready`: PostgreSQL·Redis ping과, `ENABLE_ADMISSION=true`일 때 입장 제어의 준비 상태를 확인하고 하나라도 실패하면 503 `not_ready` 반환

### 구조화된 로그

- Pino 기반 로거 사용
- 요청 ID 포함
- 시작, 종료, 에러 로그 분리

관련 파일:

- [logger.ts](../src/infra/logger.ts)
- [app.ts](../src/api/app.ts)

### 요청 ID

- `x-request-id`가 있으면 재사용합니다.
- 없으면 서버가 새 UUID 생성

### graceful shutdown

- `SIGINT`, `SIGTERM` 처리
- Redis 연결 종료를 먼저 시작하고 order sweeper·admission scheduler에 정지 요청
- reservation sweeper 정지 → HTTP 서버 종료 → order sweeper·admission scheduler 종료 대기 → PostgreSQL 연결 종료
- 순서의 이유와 장애 때의 동작은 [ADMISSION_DESIGN_AND_OPERATIONS.md](./ADMISSION_DESIGN_AND_OPERATIONS.md)의 "시작, 보호 켜기와 끄기, 종료"

### 시작 시 확인

- `admission_results`(migration 013)가 없는 DB에서는 시작 실패
- `ENABLE_ADMISSION=true`이면 Redis 설정이 `appendonly no`, `save ""`, `maxmemory-policy noeviction`이 아닐 때 시작 실패

### 환경 변수 검증

- 환경 변수는 시작할 때 schema로 검증하고, 형식이 맞지 않으면 시작하지 않습니다(`src/infra/config.ts`).
- `NODE_ENV=production`이면 아래 조합을 거부합니다. 운영 이미지(`Dockerfile`)는 `NODE_ENV=production`을 기본으로 둡니다.
  - `JWT_SECRET`이 없거나, 개발용 기본값이거나, 예전 `.env.example`에 실려 있던 값
  - `WEBHOOK_SIGNING_SECRET`이 없거나 32자 미만
  - `ENFORCE_AUTH_USER_MATCH=false`, `RATE_LIMIT_FAIL_MODE=open`, `ENABLE_RATE_LIMITING=false`
- 분기마다 거절 테스트가 있습니다(`src/tests/unit/production-invariants.test.ts`).

### GraphQL 쿼리 복잡도 제한

- Apollo plugin으로 `didResolveOperation` 단계에 연결
- `GRAPHQL_MAX_COMPLEXITY` 초과 시 resolver 진입 전에 요청을 거부합니다.
- 단위 테스트로 임계값과 합산 로직을 검증합니다.

관련 파일:

- [server.ts](../src/api/graphql/server.ts)
- [complexity.ts](../src/api/graphql/complexity.ts)
- [graphql-complexity.test.ts](../src/tests/unit/graphql-complexity.test.ts)

### 결제 settlement 이후 발급

- checkout은 주문을 `pending`으로 만듭니다.
- `POST /webhooks/payments/settlement`가 `settled` 상태를 받으면 주문을 `paid`로 전이하고 티켓을 발급합니다.
- 같은 webhook 재전송 시 중복 발급이 생기지 않도록 처리합니다.

## 실제로 확인한 항목

- 로컬 환경에서 `/health` 정상 응답 확인
- 로컬 환경에서 `/ready` 정상 응답 확인
- checkout 이후 `pending` 주문 확인
- settlement webhook 이후 `paid` 전이와 티켓 발급 확인
- duplicate settlement webhook에 대해 중복 티켓 미발급 확인
- GraphQL 쿼리 복잡도 초과 요청 거부 단위 테스트 확인

## 하지 않은 것

- payment-callback 부하 시나리오의 결과는 console 출력만 있고 저장된 summary 파일이 없습니다([PERFORMANCE_REPORT.md](./PERFORMANCE_REPORT.md)).
- settlement webhook의 rate limit은 구매 경로와 같은 한도(보낸 쪽 IP당 5회/분)를 씁니다. 결제사의 재전송을 받기에는 낮은 값이고, 부하 측정에서는 한도를 올렸습니다.
- 예약 sweeper는 5분마다 200건씩 처리하고 시작 직후에는 돌지 않습니다. 만료된 예약이 좌석을 쥔 시간만큼 품절로 보일 수 있습니다.
- 입장 제어에서 고치지 않고 받아들인 한계는 [ADMISSION_DESIGN_AND_OPERATIONS.md](./ADMISSION_DESIGN_AND_OPERATIONS.md)의 "알려진 한계"에 있습니다.
