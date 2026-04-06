# 케이스 스터디

## 문제

PeakPass는 단순 CRUD 포트폴리오가 아니라, 고트래픽 워크숍과 세미나 예약을 다루는 백엔드 포트폴리오를 목표로 한다.  
중요한 문제는 다음과 같다.

- 짧은 시간에 많은 사용자가 같은 이벤트를 조회함
- 제한된 재고를 동시에 여러 사용자가 선점하려고 함
- 클라이언트 재시도와 중복 결제 콜백이 발생할 수 있음
- 면접에서 설명 가능한 구조여야 함

## 목표

- PostgreSQL을 기준으로 정합성 보장
- Redis를 실제 운영 사례처럼 사용
- REST write-side, GraphQL read-side 분리
- Docker와 Terraform까지 포함한 운영 관점 확보

## 해결 방식

### 1. 모듈형 단일 애플리케이션

- `src/api`
- `src/core`
- `src/infra`

구조로 분리해 설명 가능성을 높였다.

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

현재 저장소 기준으로 확인된 것:

- `npm run build` 통과
- `npm test -- --runInBand` 통과
- `npm run lint` 통과
- Docker Compose 기반 로컬 기동 확인
- `/health`, `/ready` 확인
- GraphQL `events`, `myOrders`, `myTickets`, `ticketByCode` 실제 응답 확인
- checkout 직후 티켓이 비어 있고, settlement 이후 티켓이 생기는 흐름 확인
- duplicate settlement webhook에도 티켓 수가 늘지 않음을 확인

대표 검증 데이터:

- settlement 대상 주문 ID: `a63a537d-64f4-447a-8c02-91d01cc9ad40`
- settlement 이후 발급 티켓: `PASS-2026-000002`

현재 남아 있는 것:

- failed webhook과 재고 원복 시나리오를 별도 테스트로 고정
- Terraform CLI 기반 재검증
- load test 재실행과 수치 보고서 갱신

## 이 프로젝트로 보여줄 수 있는 역량

- Node.js 백엔드 부팅과 종료 흐름
- PostgreSQL 트랜잭션 설계
- Redis를 source of truth로 두지 않는 운영 감각
- GraphQL을 조회 전용으로 제한하는 구조적 판단
- settlement 이후 발급과 duplicate webhook 방어 설계
- Docker와 Terraform을 포트폴리오에 연결하는 방식
