# 운영 하드닝

이 문서는 현재 코드에 들어가 있는 운영 관점 기능과 아직 남아 있는 과제를 정리한다.

## 현재 구현된 항목

### 상태 확인 엔드포인트

- `GET /health`
- `GET /ready`

관련 파일:

- [health.ts](C:/Users/dosac/projects/PeakPass/src/api/health.ts)

동작:

- `/health`: 프로세스 생존 확인
- `/ready`: PostgreSQL, Redis ping 확인 후 준비 상태 반환

### 구조화된 로그

- Pino 기반 로거 사용
- 요청 ID 포함
- 시작, 종료, 에러 로그 분리

관련 파일:

- [logger.ts](C:/Users/dosac/projects/PeakPass/src/infra/logger.ts)
- [app.ts](C:/Users/dosac/projects/PeakPass/src/api/app.ts)

### 요청 ID

- `x-request-id`가 있으면 재사용
- 없으면 서버가 새 UUID 생성

### graceful shutdown

- `SIGINT`, `SIGTERM` 처리
- HTTP 서버 종료
- PostgreSQL, Redis 연결 정리

### 환경 변수 검증

- 설정 로딩 로직 존재
- 필수 값 누락 시 시작 단계에서 실패하도록 구성

### 결제 settlement 이후 발급

- checkout은 주문을 `pending`으로 만든다
- `POST /webhooks/payments/settlement`가 `settled` 상태를 받으면 주문을 `paid`로 전이하고 티켓을 발급한다
- 같은 webhook 재전송 시 중복 발급이 생기지 않도록 처리한다

## 실제로 확인한 항목

- Docker Compose 환경에서 `/health` 정상 응답 확인
- Docker Compose 환경에서 `/ready` 정상 응답 확인
- checkout 이후 `pending` 주문 확인
- settlement webhook 이후 `paid` 전이와 티켓 발급 확인
- duplicate settlement webhook에 대해 중복 티켓 미발급 확인

## 아직 남은 과제

- GraphQL query complexity 제한 실제 연결
- CloudWatch 로그 수집과 알람 검증
- Terraform CLI 기반 배포 검증
- 최신 load test 결과 반영
