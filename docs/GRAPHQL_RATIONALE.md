# GraphQL 사용 이유

PeakPass는 write-side를 REST, read-side를 GraphQL로 분리한다.  
이 선택은 구조를 복잡하게 만들기 위한 것이 아니라, 읽기와 쓰기의 성격 차이를 분명하게 드러내기 위한 선택이다.

## 왜 GraphQL을 read-side에만 두는가

### 1. 조회 집계에 유리함

이벤트 상세 화면이나 마이페이지 화면에서는 여러 조각의 데이터를 한 번에 읽어야 한다.

- 이벤트 기본 정보
- 남은 좌석 수량
- 가격 티어
- 내 주문 목록
- 내 티켓 목록

GraphQL은 필요한 필드만 조합해서 가져올 수 있어서 이런 화면에 잘 맞는다.

### 2. overfetching을 줄이기 쉬움

REST로 화면별 조회를 계속 늘리면 DTO가 빠르게 늘어난다.  
GraphQL은 클라이언트가 필요한 필드를 직접 고를 수 있어서 읽기 API를 단순하게 유지하기 쉽다.

### 3. DataLoader 적용 지점이 명확함

이벤트, 주문, 사용자 조회는 읽기 경로에서 중복 접근이 자주 생긴다.  
이 구간은 DataLoader로 batching과 cache를 적용하기 좋다.

## 왜 write-side는 REST로 유지하는가

- `POST /reservations`
- `POST /checkouts`
- `POST /webhooks/payments/settlement`

이런 명령형 API는 의도와 부작용이 분명해서 REST가 설명하기 쉽다.

특히 아래 항목은 REST 쪽이 경계가 선명하다.

- 멱등성 키 헤더 처리
- rate limiting
- PostgreSQL transaction 경계
- 결제 webhook 처리
- commit 이후 Redis 후처리

## 현재 구현 범위

실제 스키마와 resolver는 다음 파일에 있다.

- [types.ts](C:/Users/dosac/projects/PeakPass/src/api/graphql/types.ts)
- [resolvers.ts](C:/Users/dosac/projects/PeakPass/src/api/graphql/resolvers.ts)
- [loaders.ts](C:/Users/dosac/projects/PeakPass/src/api/graphql/loaders.ts)

현재 실제로 동작을 확인한 조회는 다음과 같다.

- `events`
- `event`
- `myOrders`
- `myTickets`
- `ticketByCode`

즉 GraphQL read-side는 이벤트 조회뿐 아니라 사용자 주문과 티켓 조회까지 실제 DB 조회로 연결된 상태다.

## 현재 설계의 장단점

장점:

- write/read 분리가 분명함
- GraphQL mutation을 남용하지 않음
- DataLoader 적용 이유를 설명하기 좋음
- `myOrders`, `myTickets`, `ticketByCode`까지 실제 응답을 확인함

제약:

- query complexity 제한 코드는 있지만 서버 경로에 아직 연결하지 않음
- read model은 현재 단일 DB 기반 조회 위주라 별도 projection 저장소는 두지 않음

## 면접에서 설명할 문장

PeakPass는 정합성이 중요한 명령 흐름은 REST와 PostgreSQL transaction으로 단순하게 유지하고, 화면 조합이 많은 조회만 GraphQL로 분리했다.  
이 방식으로 overfetching과 N+1 문제를 줄이면서도 멱등성, webhook, 결제 후 발급 같은 쓰기 흐름의 경계를 명확하게 설명할 수 있다.
