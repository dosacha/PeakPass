# GraphQL 예시

현재 GraphQL 엔드포인트는 `POST /graphql`이다.  
개발 환경에서는 `GET /graphql`로 Apollo Sandbox HTML 진입도 가능하다.

## 이벤트 목록

```graphql
query BrowseEvents($limit: Int, $offset: Int) {
  events(limit: $limit, offset: $offset) {
    id
    title
    description
    date
    capacity
    availableSeats
    pricing {
      tier
      price
      seats
      available
    }
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

```graphql
query EventDetail($id: ID!) {
  event(id: $id) {
    id
    title
    description
    date
    availableSeats
    pricing {
      tier
      price
      seats
      available
    }
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
    status
    paymentStatus
    ticketCount
    totalPrice
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
    code
    status
    order {
      id
      totalPrice
      paymentStatus
    }
    event {
      id
      title
    }
    user {
      id
      email
    }
  }
}
```

## 티켓 코드 조회

```graphql
query TicketByCode($code: String!) {
  ticketByCode(code: $code) {
    id
    code
    status
    order {
      id
      totalPrice
    }
    event {
      id
      title
    }
    user {
      id
      email
    }
  }
}
```

## curl 예시

이벤트 목록:

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query { events(limit: 5, offset: 0) { id title availableSeats } }"}'
```

인증 사용자 주문과 티켓:

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer JWT_TOKEN" \
  -d '{"query":"query { myOrders(limit: 10) { id status paymentStatus totalPrice } myTickets(limit: 10) { id code status } }"}'
```

티켓 코드 조회:

```bash
curl -X POST http://localhost:3000/graphql \
  -H "Content-Type: application/json" \
  -d '{"query":"query { ticketByCode(code: \"PASS-2026-000002\") { id code status event { title } } }"}'
```

## 실제 검증 메모

실제로 확인한 대표 응답:

- `myOrders`에서 settlement 이후 주문이 `paid`, `paymentStatus: settled`
- `myTickets`에서 settlement 이후 발급된 `PASS-2026-000002` 조회
- `ticketByCode(code: "PASS-2026-000002")` 정상 조회
