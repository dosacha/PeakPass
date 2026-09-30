const mockPool = { on: jest.fn(), connect: jest.fn(), end: jest.fn(), totalCount: 5, idleCount: 2, waitingCount: 3 };
const mockInfo = jest.fn();
let mockInterval = 100;
jest.mock('pg', () => ({ Pool: jest.fn(() => mockPool) }));
jest.mock('@/infra/config', () => ({ getConfig: () => ({ DB_POOL_SAMPLE_INTERVAL_MS: mockInterval }) }));
jest.mock('@/infra/logger', () => ({ getLogger: () => ({ info: mockInfo, error: jest.fn() }) }));
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';

it('samples actual checked-out and waiting counts only when enabled and stops on close', async () => {
  jest.useFakeTimers();
  mockPool.connect.mockResolvedValue({ query: jest.fn(), release: jest.fn() });
  await initPostgresPool();
  jest.advanceTimersByTime(100);
  expect(mockInfo).toHaveBeenCalledWith({ metric: 'postgres_pool', total: 5, idle: 2, checkedOut: 3, waiting: 3 }, 'PostgreSQL pool sample');
  await closePostgresPool();
  mockInfo.mockClear();
  jest.advanceTimersByTime(500);
  expect(mockInfo).not.toHaveBeenCalled();
  mockInterval = 0;
  await initPostgresPool();
  mockInfo.mockClear();
  jest.advanceTimersByTime(500);
  expect(mockInfo).not.toHaveBeenCalled();
  await closePostgresPool();
  jest.useRealTimers();
});
