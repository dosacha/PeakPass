# 배포 런북

이 문서는 로컬 실행, Docker 기반 실행, 운영 배포 전 점검 순서를 정리한다.

## 1. 로컬 정적 검증

```bash
npm install
npm run build
npm test -- --runInBand
npm run lint
```

현재 문서 기준 결과:

- `build` 통과
- `test` 통과
- `lint` 통과
- `no-explicit-any` 경고 17건 유지

## 2. Docker Compose 로컬 실행

현재 compose 포트는 로컬 충돌 회피를 위해 다음과 같이 맞춰져 있다.

- PostgreSQL: `5433 -> 5432`
- Redis: `6380 -> 6379`

```bash
docker compose up -d postgres redis
docker compose up -d app
```

`app` 서비스는 컨테이너 안에서 다음 순서로 실행된다.

1. migration
2. seed
3. 앱 기동

## 3. 로컬 검증 순서

1. `GET /health`
2. `GET /ready`
3. `GET /events`
4. `POST /reservations`
5. `POST /checkouts` with `Idempotency-Key`
6. `POST /webhooks/payments/settlement` with `Idempotency-Key`
7. `POST /graphql` for `events`
8. `POST /graphql` for `myOrders`
9. `POST /graphql` for `myTickets`
10. `POST /graphql` for `ticketByCode`

## 4. 실제 확인 결과

- `app` 컨테이너가 migration, seed, 서버 기동까지 완료함
- `/health` 200 확인
- `/ready` 200 확인
- GraphQL `events`, `myOrders`, `myTickets`, `ticketByCode` 응답 확인
- checkout 직후 주문은 `pending`, 티켓은 빈 배열로 반환됨
- settlement webhook 이후 주문은 `paid`로 전이되고 티켓이 발급됨
- 같은 settlement webhook 재전송 시 중복 티켓이 생기지 않음을 확인함

## 5. 운영 배포 전 점검

- Docker image build
- 환경 변수 검증
- migration 적용 계획 점검
- ALB health check 경로 확인
- 로그 수집 대상 확인
- 롤백 방법 점검

## 6. 운영 배포 순서

1. 이미지 빌드 및 푸시
2. Terraform plan 확인
3. 배포 전 DB 백업 확인
4. ECS 서비스 또는 EC2 인스턴스에 새 버전 배포
5. `/health`, `/ready` 확인
6. 예약, checkout, settlement webhook smoke test
7. GraphQL 조회 smoke test

## 7. 롤백

- 이전 이미지 태그로 되돌림
- schema 변경이 호환 불가이면 migration 순서를 먼저 점검
- Redis cache는 보조 계층이므로 필요 시 비워도 DB 기준으로 복구 가능

## 8. 남은 운영 과제

- Terraform CLI 기준 `fmt`, `validate`, `plan` 재검증
- load test 최신 수치 반영
- CloudWatch 로그와 알람 연결 검증
