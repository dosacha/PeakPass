import { PoolClient } from 'pg';
import { InsufficientInventoryError, NotFoundError } from '../errors';

export class InventoryService {
  /**
   * Adjusts event inventory atomically inside the caller's transaction.
   *
   * Positive delta returns seats; negative delta reserves or sells seats.
   * The event row is locked with FOR UPDATE so every inventory path uses the
   * same race-free accounting rule.
   */
  async adjustAvailableSeats(
    eventId: string,
    delta: number,
    client: PoolClient,
  ): Promise<number> {
    const lockResult = await client.query<{ available_seats: number }>(
      `SELECT available_seats FROM events WHERE id = $1 FOR UPDATE`,
      [eventId],
    );

    if (lockResult.rows.length === 0) {
      throw new NotFoundError('Event', eventId);
    }

    const current = lockResult.rows[0].available_seats;
    const next = current + delta;

    if (delta < 0 && next < 0) {
      throw new InsufficientInventoryError(current, Math.abs(delta));
    }

    await client.query(
      `UPDATE events SET available_seats = $1 WHERE id = $2`,
      [next, eventId],
    );

    return next;
  }
}
