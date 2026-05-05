# 기술 Q&A

이 문서는 PeakPass 면접 답변을 위한 기술 질문과 답변을 정리한다. 답변은 현재 코드 기준으로 작성했다.

## 1. 왜 PostgreSQL을 source of truth로 두었는가

좌석 수, 주문 상태, 결제 기록, 티켓 발급은 rollback 가능한 트랜잭션 안에서 다뤄야 한다. Redis는 TTL과 cache에는 빠르지만 영속 정합성의 기준 저장소로 두기 어렵다. 그래서 `events.available_seats`, `orders`, `reservations`, `tickets`, `payment_records`는 PostgreSQL에 두고, Redis는 보조 계층으로만 사용한다.

근거 파일:

- `src/infra/migrations/001_init_schema.sql`
- `src/core/services/reservation.service.ts`
- `src/core/services/checkout.service.ts`

## 2. Redis는 어디에 쓰는가

Redis는 네 가지 용도로 사용한다.

- reservation TTL hold
- checkout, reservation, webhook rate limit
- idempotency result cache와 in-progress lock
- event, inventory cache

TTL 값은 `REDIS_TTL`에 정의되어 있고, reservation hold는 300초, event cache는 600초, inventory cache는 60초, idempotency 결과는 86400초를 기본으로 한다.

근거 파일:

- `src/infra/redis/commands.ts`
- `docs/REDIS_STRATEGY.md`

## 3. reservation 단계에서 oversell을 어떻게 막는가

`ReservationService.createReservationWithClient()`가 `events` 행을 `FOR UPDATE`로 잠근다. 재고가 충분할 때만 같은 트랜잭션 안에서 `available_seats`를 차감하고 `reservations` 행을 `active`로 저장한다. 여러 요청이 동시에 들어와도 같은 이벤트 행에 대한 차감은 직렬화된다.

근거 파일:

- `src/core/services/reservation.service.ts`

## 4. checkout 단계에서 oversell을 어떻게 막는가

`POST /checkouts`는 `serializableTransactionWithRetry()`로 실행된다. reservation이 없는 직접 checkout은 이벤트 행을 `FOR UPDATE`로 잠그고 재고 확인, 주문 생성, 좌석 차감을 같은 트랜잭션 안에서 처리한다. reservation이 있는 checkout은 이미 reservation 단계에서 좌석이 차감되었으므로 추가 차감하지 않는다.

근거 파일:

- `src/api/rest/checkouts.ts`
- `src/core/services/checkout.service.ts`
- `src/infra/postgres/client.ts`

## 5. reservation을 checkout에 사용할 때 race condition은 어떻게 줄이는가

checkout은 valid 체크와 convert를 분리하지 않고, 다음 atomic update로 처리한다.

```sql
UPDATE reservations
SET status = 'converted'
WHERE id = $1 AND status = 'active' AND expires_at > NOW()
RETURNING id
```

이 쿼리는 active 상태와 만료 시간을 확인하면서 동시에 converted로 전환한다. 실패하면 lazy expire를 시도하고 `ConflictError`를 반환한다.

근거 파일:

- `src/core/services/checkout.service.ts`

## 6. Idempotency-Key는 어디에서 방어하는가

첫 번째 방어는 `idempotencyMiddleware`다. POST `/checkouts`와 `/webhooks` 요청에서 `Idempotency-Key`를 읽고, Redis result cache와 in-progress lock을 사용한다. 두 번째 방어는 DB다. `orders.idempotency_key`는 unique이고, `payment_records.idempotency_key`도 unique이다. 따라서 Redis lock이 실패하더라도 DB 제약이 최종 중복 생성을 막는다.

근거 파일:

- `src/api/middleware/idempotency.ts`
- `src/infra/migrations/001_init_schema.sql`
- `src/core/services/checkout.service.ts`

## 7. 왜 checkout 직후 티켓을 발급하지 않는가

checkout은 결제 전 주문 생성 단계다. 이 시점에는 주문을 `pending`으로 만들고 `payment_records`도 `pending`으로 둔다. 티켓은 결제가 확정된 settlement webhook에서만 발급한다. 결제 확정 전 티켓이 생기는 문제를 막기 위한 분리다.

근거 파일:

- `src/core/services/checkout.service.ts`
- `src/api/rest/payments.ts`

## 8. duplicate settlement webhook은 어떻게 막는가

webhook도 `Idempotency-Key`를 사용하고, `payment_records.provider_transaction_id`에 partial unique index가 있다. 서비스 내부에서는 order를 `FOR UPDATE`로 잠근다. 이미 `paid` 상태면 duplicate로 처리하고 기존 티켓을 반환한다. 아직 paid가 아니더라도 기존 티켓이 있으면 새로 발급하지 않는다.

근거 파일:

- `src/api/rest/payments.ts`
- `src/core/services/checkout.service.ts`
- `src/infra/migrations/003_payment_provider_transaction_unique.sql`

## 9. webhook signature는 어떻게 검증하는가

Fastify 앱은 JSON parser를 직접 등록해 raw body Buffer를 `request.rawBody`에 보존한다. webhook middleware는 `WEBHOOK_SIGNING_SECRET`이 있을 때 `X-Webhook-Signature`와 `X-Webhook-Timestamp`를 요구한다. 서명 payload는 `${timestamp}.${rawBody}`이고 HMAC-SHA256 hex digest를 timing-safe compare로 검증한다. timestamp는 기본 300초 허용 범위 안에 있어야 한다.

근거 파일:

- `src/api/app.ts`
- `src/api/middleware/webhook-signature.ts`
- `src/infra/config.ts`
- `src/tests/unit/webhook-signature.test.ts`

## 10. GraphQL은 어디까지 구현되어 있는가

GraphQL endpoint는 `POST /graphql`이다. 현재 query는 `events`, `event`, `myOrders`, `myTickets`, `ticketByCode`가 있다. `events`와 `event`는 이벤트 조회에 연결되고, `myOrders`, `myTickets`, `ticketByCode`는 checkout service의 DB 조회 메서드로 연결된다. query complexity plugin은 `didResolveOperation` 단계에서 resolver 진입 전에 비용을 계산한다.

근거 파일:

- `src/api/graphql/types.ts`
- `src/api/graphql/resolvers.ts`
- `src/api/graphql/server.ts`
- `src/api/graphql/complexity.ts`
- `src/tests/unit/graphql-complexity.test.ts`

## 11. rate limit은 어떤 정책인가

rate limit middleware는 reservation, checkout, webhook 경로에 적용된다. 사용자 ID가 있으면 사용자 ID를 쓰고, 없으면 IP를 fallback으로 쓴다. Redis sorted set 기반 sliding window로 count를 계산하며, 기본 실패 모드는 `RATE_LIMIT_FAIL_MODE=closed`다. Redis 장애와 fail-closed 조합에서는 `503 RATE_LIMIT_UNAVAILABLE`을 반환한다.

근거 파일:

- `src/api/middleware/rateLimit.ts`
- `src/infra/redis/commands.ts`
- `src/infra/config.ts`

## 12. 운영 준비는 무엇이 되어 있는가

앱은 `/health`와 `/ready`를 제공한다. `/health`는 생존 확인이고 `/ready`는 PostgreSQL, Redis 상태를 확인한다. `src/main.ts`에는 graceful shutdown이 있어 HTTP 서버, PostgreSQL pool, Redis 연결을 닫는다. Fastify에는 request id와 구조화 로그가 연결되어 있다.

근거 파일:

- `src/main.ts`
- `src/api/app.ts`
- `src/api/health.ts`
- `src/infra/logger.ts`
- `docs/PRODUCTION_HARDENING.md`

## 13. 남은 과제는 무엇인가

운영 수준으로 보강하려면 인증 subject와 body userId의 관계를 더 강하게 제한해야 한다. payment callback 부하 테스트는 HMAC timestamp header 반영 후 결과를 추가해야 한다. Terraform은 구조가 있지만 실제 운영 apply와 CloudWatch 알람 검증은 별도 과제다.

근거 파일:

- `README.md`
- `docs/PERFORMANCE_REPORT.md`
- `docs/DEPLOYMENT_RUNBOOK.md`