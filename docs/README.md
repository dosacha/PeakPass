# PeakPass 문서 안내

이 디렉터리는 PeakPass의 공개 문서를 모아 둔 공간이다.  
문서는 현재 코드 기준 구현 상태와 실제로 확인한 동작 범위를 중심으로 정리한다.

## 먼저 읽을 문서

1. [ARCHITECTURE_DIAGRAMS.md](C:/Users/dosac/projects/PeakPass/docs/ARCHITECTURE_DIAGRAMS.md)
2. [TRANSACTION_CONSISTENCY.md](C:/Users/dosac/projects/PeakPass/docs/TRANSACTION_CONSISTENCY.md)
3. [REDIS_STRATEGY.md](C:/Users/dosac/projects/PeakPass/docs/REDIS_STRATEGY.md)
4. [GRAPHQL_RATIONALE.md](C:/Users/dosac/projects/PeakPass/docs/GRAPHQL_RATIONALE.md)
5. [DEPLOYMENT_RUNBOOK.md](C:/Users/dosac/projects/PeakPass/docs/DEPLOYMENT_RUNBOOK.md)

## 주제별 문서

### 아키텍처

- [ARCHITECTURE_DIAGRAMS.md](C:/Users/dosac/projects/PeakPass/docs/ARCHITECTURE_DIAGRAMS.md)
- [CASE_STUDY.md](C:/Users/dosac/projects/PeakPass/docs/CASE_STUDY.md)
- [adr/0001-read-write-separation.md](C:/Users/dosac/projects/PeakPass/docs/adr/0001-read-write-separation.md)

### 정합성과 데이터 처리

- [TRANSACTION_CONSISTENCY.md](C:/Users/dosac/projects/PeakPass/docs/TRANSACTION_CONSISTENCY.md)
- [REDIS_STRATEGY.md](C:/Users/dosac/projects/PeakPass/docs/REDIS_STRATEGY.md)
- [GRAPHQL_RATIONALE.md](C:/Users/dosac/projects/PeakPass/docs/GRAPHQL_RATIONALE.md)
- [GRAPHQL_EXAMPLES.md](C:/Users/dosac/projects/PeakPass/docs/GRAPHQL_EXAMPLES.md)

### 운영과 배포

- [PRODUCTION_HARDENING.md](C:/Users/dosac/projects/PeakPass/docs/PRODUCTION_HARDENING.md)
- [DEPLOYMENT_RUNBOOK.md](C:/Users/dosac/projects/PeakPass/docs/DEPLOYMENT_RUNBOOK.md)
- [AWS_DEPLOYMENT.md](C:/Users/dosac/projects/PeakPass/docs/AWS_DEPLOYMENT.md)

### 성능과 부하 테스트

- [LOAD_TEST_STRATEGY.md](C:/Users/dosac/projects/PeakPass/docs/LOAD_TEST_STRATEGY.md)
- [PERFORMANCE_REPORT.md](C:/Users/dosac/projects/PeakPass/docs/PERFORMANCE_REPORT.md)

## 읽을 때 알고 있으면 좋은 점

- PostgreSQL이 source of truth다.
- Redis는 TTL, cache, rate limit, idempotency를 맡는 보조 계층이다.
- checkout은 주문만 `pending`으로 만들고, settlement webhook 이후에 티켓을 발급한다.
- GraphQL은 `events`, `event`, `myOrders`, `myTickets`, `ticketByCode`까지 실제 응답을 확인했다.
- Docker Compose 기반 로컬 end-to-end 검증을 완료했다.
- Terraform 문서는 구조와 절차를 설명하며, CLI 재검증은 별도 과제로 남아 있다.
