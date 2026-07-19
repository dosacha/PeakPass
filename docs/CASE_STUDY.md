# CASE_STUDY

## 문제

PeakPass는 고트래픽 워크숍과 세미나 예약을 다루는 백엔드 시스템입니다.
중요한 문제는 다음과 같습니다.

- 짧은 시간에 많은 사용자가 같은 이벤트를 조회함
- 제한된 재고를 동시에 여러 사용자가 선점하려고 함
- 클라이언트 재시도와 중복 결제 콜백이 발생할 수 있음

## 목표

- PostgreSQL을 기준으로 정합성 보장
- Redis를 실제 사용 사례처럼 활용
- REST write-side, GraphQL read-side 분리
- 부하 테스트로 정합성 동작을 정량 검증

## 해결 방식

### 1. 모듈형 단일 애플리케이션

- `src/api`
- `src/core`
- `src/infra`

구조로 분리해 설명 가능성을 높였습니다.

### 2. 쓰기 흐름과 읽기 흐름 분리

- REST는 예약 생성, 체크아웃, settlement webhook 같은 명령 처리
- GraphQL은 이벤트와 마이페이지 조회 같은 read aggregation

### 3. 정합성 우선 설계

- SERIALIZABLE 트랜잭션
- `SELECT ... FOR UPDATE`
- `idempotency_key` 기반 중복 방지
- Redis는 보조 계층

### 4. settlement 이후 발급

- checkout에서는 주문만 `pending`으로 생성
- payment record는 `pending`으로 생성
- settlement webhook이 오면 order를 `paid`로 전환
- 그 시점에만 티켓 발급
- duplicate settlement webhook에는 기존 결과를 재사용

## 결과

현재 저장소 기준으로 확인된 사항은 다음과 같습니다.

- `npm run build`, `npm test -- --runInBand`, `npm run lint` 통과
- 로컬 환경에서 reservation → checkout → settlement → 티켓 발급 end-to-end 흐름 확인
- `/health`, `/ready` 확인
- GraphQL `events`, `myOrders`, `myTickets`, `ticketByCode` 실제 응답 확인
- checkout 직후 티켓이 비어 있고, settlement 이후 티켓이 생기는 흐름 확인
- **route-level 통합 테스트**로 middleware(HMAC, rate limit, idempotency)를 포함한
  checkout 멱등성·settlement 동시성 계약 고정 (`test:routes`)
- Redis를 의도적으로 중단시킨 상태에서도 동일 멱등키의 동시 checkout이
  PostgreSQL advisory lock + UNIQUE로 order 1건에 수렴함을 확인
- failed webhook의 좌석 원복, paid 이후 late failure의 좌석 미복구,
  duplicate settlement 방어를 통합 테스트로 고정 (`test:webhook`)
- DB 제약 계층 검증: command별 idempotency scope(005), status 허용 집합 CHECK(006),
  좌석 하한·상한 CHECK(007)를 clean install / 순차 upgrade / drift 실패까지
  격리 DB 테스트로 고정 (`test:constraints`, `test:inventory-constraints`)
- k6 부하 시나리오 재실행과 수치 보고서 갱신 (2026-06-03,
  [PERFORMANCE_REPORT.md](./PERFORMANCE_REPORT.md) — 로컬 단일 노드 micro-benchmark 한정)

현재 남아 있는 과제는 다음과 같습니다.

- 사용자용 명시적 예약 취소(release) HTTP route는 미구현 (서비스 메서드만 존재)
- 이벤트/재고 read-through cache는 미구현 — 도입 시 무효화 hook과 짝 맞추기
- 공개 데모 데이터 누적에 대한 정리 전략

## 다루는 핵심 기술 영역

- Node.js 백엔드 부팅과 종료 흐름 설계
- PostgreSQL 트랜잭션 설계와 격리 수준 선택
- Redis를 source of truth로 두지 않는 보조 계층 활용
- GraphQL을 조회 전용으로 제한하는 구조적 판단
- settlement 이후 발급과 duplicate webhook 방어 설계
- k6 기반 부하 테스트로 정합성 동작을 정량 검증