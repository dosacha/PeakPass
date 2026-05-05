import { z } from 'zod';

export const OrderStatus = z.enum(['pending', 'paid', 'delivered', 'cancelled']);
export type OrderStatus = z.infer<typeof OrderStatus>;

export interface Order {
  id: string;
  userId: string;
  eventId: string;
  quantity: number;
  tierId: string;
  /**
   * 단위가격. DB는 NUMERIC(10,2)이고 pg 드라이버는 이를 *string*으로 반환한다.
   * 이전에는 타입이 `Decimal`로 선언되어 있었지만 실제 런타임 값은 한 번도 Decimal 인스턴스가
   * 아니었고, INSERT 시점에도 호출자가 toString()으로 직렬화한 string을 전달했다.
   *
   * 산술이 필요한 호출자는 `new Decimal(order.unitPrice)`로 명시적으로 wrap한다.
   * 이렇게 두면 직렬화 경계에서 정밀도 손실 없이 string-first로 흐른다.
   */
  unitPrice: string;
  totalAmount: string;
  status: OrderStatus;
  idempotencyKey: string;
  reservationId?: string;
  createdAt: Date;
  updatedAt: Date;
  paidAt?: Date;
}

export const CreateOrderSchema = z.object({
  eventId: z.string().uuid(),
  userId: z.string().uuid(),
  quantity: z.number().int().positive().max(100),
  tierId: z.string(),
  idempotencyKey: z.string().uuid(),
  reservationId: z.string().uuid().optional(),
});

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;