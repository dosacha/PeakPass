# 면접 스토리 모음

이 문서는 PeakPass를 짧은 이야기 단위로 설명하기 위한 문장 모음이다. 각 문단은 면접에서 한 질문을 받았을 때 바로 꺼내 말할 수 있는 크기로 작성했다.

## 1. 프로젝트 한 줄 소개

PeakPass는 워크숍과 세미나 티켓팅 흐름을 다루는 TypeScript 백엔드 프로젝트입니다. 단순 CRUD보다 좌석 재고, 예약 hold, 결제 확정, 티켓 발급, 중복 webhook 같은 정합성 문제를 코드로 설명할 수 있게 만드는 것이 목표였습니다.

## 2. 정합성 스토리

가장 중요한 기준은 PostgreSQL입니다. reservation 생성은 이벤트 행을 `FOR UPDATE`로 잠그고 좌석을 먼저 차감합니다. checkout은 `SERIALIZABLE` 트랜잭션 안에서 실행되고, reservation을 사용한 경우에는 좌석을 다시 차감하지 않고 `converted` 상태로 전환합니다. 그래서 같은 좌석을 여러 사용자가 동시에 잡으려 해도 DB 행 잠금과 트랜잭션이 최종 방어선이 됩니다.

## 3. Redis 스토리

Redis는 빠른 계층이지만 진실의 원천은 아닙니다. PeakPass에서 Redis는 reservation TTL hold, rate limit, idempotency 결과 cache, 이벤트 cache에 사용됩니다. DB commit 이후에 Redis 부작용을 반영하려고 했고, Redis miss가 나도 DB의 `status`와 `expires_at`를 기준으로 다시 판단할 수 있게 했습니다.

## 4. GraphQL 스토리

GraphQL은 조회 집계 전용으로 제한했습니다. `events`, `event`, `myOrders`, `myTickets`, `ticketByCode`는 실제 resolver와 DB 조회로 연결되어 있습니다. 반대로 예약, checkout, settlement webhook은 REST로 남겨서 멱등성 헤더, rate limit, 트랜잭션 경계가 더 선명하게 보이도록 했습니다.

## 5. 결제와 티켓 발급 스토리

checkout은 주문을 `pending`으로 만들고 티켓은 발급하지 않습니다. `POST /webhooks/payments/settlement`가 `settled` 상태를 받았을 때 주문을 `paid`로 전환하고 그때 티켓을 발급합니다. duplicate webhook이 오면 order를 `FOR UPDATE`로 잠근 뒤 이미 paid이거나 기존 티켓이 있으면 중복 발급 없이 기존 결과를 돌려줍니다.

## 6. 보안과 webhook 스토리

webhook 서명 검증은 raw body가 필요하기 때문에 Fastify의 JSON parser를 직접 등록해 Buffer를 보존했습니다. `WEBHOOK_SIGNING_SECRET`이 설정된 환경에서는 `X-Webhook-Signature`와 `X-Webhook-Timestamp`를 요구하고, 타임스탬프는 기본 300초 replay window 안에 있어야 합니다. production에서는 secret이 없으면 시작 단계에서 실패합니다.

## 7. 운영 준비 스토리

앱은 `src/main.ts`에서 설정 로딩, 로거 초기화, PostgreSQL, Redis, Fastify 순서로 시작합니다. `/health`는 프로세스 생존 확인이고 `/ready`는 PostgreSQL과 Redis 상태까지 확인합니다. 종료 시에는 HTTP 서버, PostgreSQL pool, Redis 연결을 정리하는 graceful shutdown을 둔 점도 운영 관점에서 설명할 수 있습니다.

## 8. 부하 테스트 스토리

k6 시나리오는 read baseline, read spike, sustained reservation, rate-limit 비교로 나뉩니다. commit된 결과 기준으로 read spike는 200 VU에서도 p95 15.6 ms였고, reservation sustained는 완전한 reservation 흐름에서 258.4 RPS, 0% 에러를 기록했습니다. rate limit on 비교 시나리오는 대부분 fail-fast로 거부되어 fail-closed 정책을 정량적으로 확인했습니다.

## 9. 배포 스토리

로컬은 Docker Compose로 PostgreSQL, Redis, 앱을 함께 띄우는 흐름을 제공합니다. 데모 환경은 EC2 단일 노드와 Nginx reverse proxy 구성을 README에 정리했고, `terraform/`에는 ECS, RDS, ElastiCache 같은 분산 운영 구성을 코드로 남겼습니다. 현 데모와 Terraform 구성은 학습 데모와 프로덕션 구조의 대비로 설명합니다.

## 10. 현재 상태를 솔직하게 말하는 문장

핵심 정합성 흐름, settlement 이후 티켓 발급, duplicate webhook 방어, GraphQL read-side는 구현되어 있습니다. 다만 실제 운영 트래픽에서 장기간 검증된 시스템은 아니며, Terraform apply와 CloudWatch 알람 같은 운영 검증은 별도 과제로 남아 있습니다. 그래서 이 프로젝트는 운영 완성품이라기보다 티켓팅 도메인의 정합성 문제를 코드로 설명하기 위한 학습형 백엔드 포트폴리오라고 말하는 것이 정확합니다.