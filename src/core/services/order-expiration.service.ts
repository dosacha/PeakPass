import { PoolClient } from 'pg';
import { NotFoundError } from '../errors';
import { Order } from '../models/order';
import { InventoryService } from './inventory.service';
import { OrderService } from './order.service';

export type OrderExpirationOutcome = {
  kind: 'expired_now' | 'already_expired' | 'already_paid' | 'cancelled' | 'delivered' | 'no_deadline' | 'not_due';
  order: Order;
};

export class OrderExpirationService {
  private orders = new OrderService();
  private inventory = new InventoryService();

  /** Caller owns BEGIN/COMMIT/ROLLBACK and retries. Locks order then event, like payment failure.
   * PostgreSQL time decides eligibility. No Redis or reservation mutation belongs in this transaction.
   */
  async expirePendingOrderWithClient(orderId: string, client: PoolClient): Promise<OrderExpirationOutcome> {
    const order = await this.orders.getOrderByIdForUpdate(orderId, client);
    if (!order) throw new NotFoundError('Order', orderId);
    switch (order.status) {
      case 'expired': return { kind: 'already_expired', order };
      case 'paid': return { kind: 'already_paid', order };
      case 'cancelled': return { kind: 'cancelled', order };
      case 'delivered': return { kind: 'delivered', order };
    }
    if (order.paymentDeadlineAt === null) return { kind: 'no_deadline', order };
    const due = await client.query<{ due: boolean }>(
      'SELECT payment_deadline_at <= NOW() AS due FROM orders WHERE id=$1', [orderId],
    );
    if (!due.rows[0].due) return { kind: 'not_due', order };

    await this.inventory.adjustAvailableSeats(order.eventId, order.quantity, client);
    await client.query("UPDATE orders SET status='expired' WHERE id=$1", [orderId]);
    return { kind: 'expired_now', order: (await this.orders.getOrderById(orderId, client))! };
  }
}
