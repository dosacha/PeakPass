# 애플리케이션 안정성

이 문서는 현재 코드에 들어가 있는 애플리케이션 안정성 관련 기능과 아직 남아 있는 과제를 정리합니다.

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

- 설정 로딩 로직 존재
- 필수 값 누락 시 시작 단계에서 실패하도록 구성

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

## 아직 남은 과제

- payment-callback 부하 테스트 결과 고정 (수치는 [PERFORMANCE_REPORT.md](./PERFORMANCE_REPORT.md)에 있으나 저장된 summary 파일이 없음)
- 입장 제어 각 단계가 고치지 않고 남긴 한계와 미실시 검증 (follow-up Issue #25, #27, #29, #32, #34, #36)
