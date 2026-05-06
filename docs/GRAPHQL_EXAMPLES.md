# GraphQL 예시

현재 GraphQL 엔드포인트는 `POST /graphql`이다.  
개발 환경에서는 `GET /graphql`로 Apollo Sandbox HTML 진입도 가능하다.

## 이벤트 목록

목록 화면은 가벼운 필드만 가져온다. `description`, `pricing`, `my*` 컨텍스트는 상세 화면에서만 요청한다.

```graphql
query EventListPage($limit: Int, $offset: Int) {
  events(limit: $limit, offset: $offset) {
    id
    name
    startsAt
    availableSeats
  }
}
```

변수 예시:

```json
{
  "limit": 5,
  "offset": 0
}
```

## 이벤트 상세

상세 화면은 같은 이벤트 데이터 소스에서 무거운 설명, 가격 등급, 인증 사용자 컨텍스트를 한 번에 조합한다.

```graphql
query EventDetailPage($eventId: ID!) {
  event(id: $eventId) {
    id
    name
    description
    startsAt
    totalSeats
    availableSeats
    pricing {
      tierId
      name
      price
      seats
    }
    myActiveReservation {
      id
      tierId
      quantity
      expiresAt
      status
    }
    myTicketCount
  }
}
```

## 내 주문

`myOrders`는 실제 `orders`와 `payment_records`를 읽는다.

```graphql
query MyOrders($limit: Int, $offset: Int) {
  myOrders(limit: $limit, offset: $offset) {
    id
    eventId
    quantity
    totalAmount
    status
    paymentStatus
    idempotencyKey
  }
}
```

## 내 티켓

`myTickets`는 실제 `tickets`를 읽고, nested field는 DataLoader로 묶어 조회한다.

```graphql
query MyTickets($limit: Int, $offset: Int) {
  myTickets(limit: $limit, offset: $offset) {
    id
    ticketNumber
    status
    issuedAt
    expiresAt
    order {
      id
      totalAmount
      paymentStatus
    }
    event {
      id
      name
      startsAt
    }
  }
}
```

## 티켓 코드 조회

`ticketByCode`는 게이트 검증용 공개 DTO만 반환한다. 사용자 식별 정보, 주문, 결제 정보는 노출하지 않는다.

```graphql
query TicketByCode($code: String!) {
  ticketByCode(code: $code) {
    valid
    status
    ticketNumber
    eventName
    startsAt
    endsAt
  }
}
```

## curl 예시

이벤트 목록:

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query { events(limit: 5, offset: 0) { id name startsAt availableSeats } }"}'
```

인증 사용자 주문과 티켓:

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer JWT_TOKEN" \
  -d '{"query":"query { myOrders(limit: 10) { id status paymentStatus totalAmount } myTickets(limit: 10) { id ticketNumber status } }"}'
```

티켓 코드 조회:

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query { ticketByCode(code: \"PASS-2026-000002\") { valid status ticketNumber eventName startsAt endsAt } }"}'
```

## 실제 검증 메모

실제로 확인한 대표 응답:

- `events` 목록은 목록 화면에 필요한 필드만 조회
- `event` 상세는 `pricing`, `myActiveReservation`, `myTicketCount`를 한 번에 조합
- `myOrders`에서 settlement 이후 주문이 `paid`, `paymentStatus: settled`
- `myTickets`에서 settlement 이후 발급된 `PASS-2026-000002` 조회
- `ticketByCode(code: "PASS-2026-000002")`는 검증 DTO로만 응답
