import { buildSchema, GraphQLSchema } from 'graphql';

export const graphqlTypeDefs = `
  """
  워크숍이나 세미나 이벤트, 좌석 재고 포함
  """
  type Event {
    id: ID!
    title: String!
    description: String
    date: String!
    capacity: Int!
    availableSeats: Int!
    pricing: [PricingTier!]!
    createdAt: String!
    updatedAt: String!
  }

  """
  이벤트 가격 등급 (표준, VIP 등)
  """
  type PricingTier {
    tier: String!
    price: Float!
    seats: Int!
    available: Int!
  }

  """
  확인된 구매 주문
  """
  type Order {
    id: ID!
    userId: ID!
    eventId: ID!
    event: Event!
    ticketCount: Int!
    totalPrice: Float!
    status: String!
    paymentStatus: String!
    idempotencyKey: String
    createdAt: String!
    updatedAt: String!
  }

  """
  결제 확인 후 발급된 디지털 패스
  """
  type Ticket {
    id: ID!
    orderId: ID!
    order: Order!
    eventId: ID!
    event: Event!
    userId: ID!
    user: User!
    code: String!
    status: String!
    issuedAt: String!
    expiresAt: String
  }

  """
  사용자/참석자 프로필
  """
  type User {
    id: ID!
    email: String!
    name: String
    createdAt: String!
  }

  """
  쿼리 루트 - 모든 읽기 작업
  N+1 쿼리 방지를 위해 DataLoader 활용
  """
  type Query {
    """
    페이지네이션으로 모든 이벤트 조회
    """
    events(limit: Int, offset: Int): [Event!]!

    """
    ID로 이벤트 조회
    """
    event(id: ID!): Event

    """
    인증된 사용자의 모든 주문 조회
    이벤트 효율적 조회를 위해 DataLoader로 배치됨
    """
    myOrders(limit: Int, offset: Int): [Order!]!

    """
    인증된 사용자의 모든 티켓 조회
    주문과 이벤트 효율적 조회를 위해 DataLoader로 배치됨
    """
    myTickets(limit: Int, offset: Int): [Ticket!]!

    """
    코드로 티켓 조회 (스캔/검증용)
    """
    ticketByCode(code: String!): Ticket
  }

  schema {
    query: Query
  }
`;

// 스키마 빌드 및 검증
export function buildGraphQLSchema(): GraphQLSchema {
  try {
    return buildSchema(graphqlTypeDefs);
  } catch (err) {
    throw new Error(`Failed to build GraphQL schema: ${err instanceof Error ? err.message : String(err)}`);
  }
}
