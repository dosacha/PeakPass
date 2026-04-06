import { z } from 'zod';
import Decimal from 'decimal.js';

export const OrderStatus = z.enum(['pending', 'paid', 'delivered', 'cancelled']);
export type OrderStatus = z.infer<typeof OrderStatus>;

export interface Order {
  id: string;
  userId: string;
  eventId: string;
  quantity: number;
  tierId: string;
  unitPrice: Decimal;
  totalAmount: Decimal;
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
