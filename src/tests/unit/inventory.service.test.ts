import { PoolClient } from 'pg';
import { InventoryService } from '@/core/services/inventory.service';
import { InsufficientInventoryError, NotFoundError } from '@/core/errors';

function createClientWithAvailableSeats(availableSeats: number): PoolClient {
  return {
    query: jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ available_seats: availableSeats }] })
      .mockResolvedValueOnce({ rows: [] }),
  } as unknown as PoolClient;
}

describe('InventoryService.adjustAvailableSeats', () => {
  const service = new InventoryService();

  it('decrements seats atomically using a locked event row', async () => {
    const client = createClientWithAvailableSeats(10);

    await expect(
      service.adjustAvailableSeats('event-1', -3, client),
    ).resolves.toBe(7);

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      `SELECT available_seats FROM events WHERE id = $1 FOR UPDATE`,
      ['event-1'],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      `UPDATE events SET available_seats = $1 WHERE id = $2`,
      [7, 'event-1'],
    );
  });

  it('throws InsufficientInventoryError when seats would go negative', async () => {
    const client = createClientWithAvailableSeats(2);

    await expect(
      service.adjustAvailableSeats('event-1', -3, client),
    ).rejects.toBeInstanceOf(InsufficientInventoryError);

    expect(client.query).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundError when the event does not exist', async () => {
    const client = {
      query: jest.fn().mockResolvedValueOnce({ rows: [] }),
    } as unknown as PoolClient;

    await expect(
      service.adjustAvailableSeats('missing-event', -1, client),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
