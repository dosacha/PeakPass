import { buildSchema } from 'graphql';
import { graphqlTypeDefs } from '@/api/graphql/types';
import type { Order } from '@/core/models/order';
import type { GraphQLOrder } from '@/api/graphql/loaders';

/**
 * 화폐(unitPrice/totalAmount)는 직렬화 경계에서 string으로 통일한다.
 *
 * 배경: pg 드라이버는 NUMERIC을 string으로 반환한다. 이전에는 모델 타입을
 * Decimal로 거짓 선언하고 GraphQL resolver에서 Number()로 변환했는데,
 * Number 변환은 IEEE 754 double 정밀도 손실 위험이 있다. 모든 직렬화 경계를
 * string-first로 통일해 정밀도 손실을 차단한다.
 *
 * 이 테스트는 다음을 회귀 방지로 고정한다:
 *   1. Order.unitPrice/totalAmount의 *타입 선언*이 string인지 (컴파일 타임)
 *   2. GraphQLOrder.totalAmount의 *타입 선언*이 string인지 (컴파일 타임)
 *   3. GraphQL 스키마의 Order.totalAmount가 String! 인지 (런타임)
 */
describe('money serialization consistency (string-first)', () => {
  it('Order model declares unitPrice/totalAmount as string', () => {
    // 다음 객체 리터럴이 컴파일되면 Order 타입이 string을 받아들인다는 증거.
    // 만약 누군가 unitPrice를 다시 Decimal로 되돌리면 이 테스트가 컴파일 fail로 잡힌다.
    const sample: Order = {
      id: '00000000-0000-0000-0000-000000000000',
      userId: '00000000-0000-0000-0000-000000000001',
      eventId: '00000000-0000-0000-0000-000000000002',
      quantity: 1,
      tierId: 'general',
      unitPrice: '50.00',
      totalAmount: '50.00',
      status: 'pending',
      idempotencyKey: '00000000-0000-0000-0000-000000000003',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    expect(typeof sample.unitPrice).toBe('string');
    expect(typeof sample.totalAmount).toBe('string');
  });

  it('GraphQLOrder declares totalAmount as string', () => {
    const sample: GraphQLOrder = {
      id: 'order-1',
      userId: 'user-1',
      eventId: 'event-1',
      quantity: 2,
      totalAmount: '100.50',
      status: 'pending',
      paymentStatus: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };

    expect(typeof sample.totalAmount).toBe('string');
  });

  it('GraphQL schema declares Order.totalAmount as String!', () => {
    const schema = buildSchema(graphqlTypeDefs);
    const orderType = schema.getType('Order');
    if (!orderType) {
      throw new Error('Order type missing from GraphQL schema');
    }

    // GraphQLObjectType에는 getFields()가 있다. 직접 호출하기 위해 좁힌다.
    const fields = (orderType as { getFields: () => Record<string, { type: unknown }> }).getFields();
    const totalAmountField = fields.totalAmount;

    if (!totalAmountField) {
      throw new Error('Order.totalAmount field missing');
    }

    // String! 은 toString시 정확히 "String!" 으로 직렬화된다.
    expect(String(totalAmountField.type)).toBe('String!');
  });
});
