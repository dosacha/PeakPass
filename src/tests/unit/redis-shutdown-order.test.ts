import { setImmediate as nextTurn } from 'timers/promises';

it('gates Redis at signal entry before waiting for HTTP drain or PostgreSQL close', async () => {
  jest.resetModules();
  const events: string[] = [];
  let drain!: () => void;
  const drained = new Promise<void>((resolve) => { drain = resolve; });
  let signal!: () => void;
  const logger = { info: jest.fn(), error: jest.fn() };
  jest.doMock('@/infra/config', () => ({ loadConfig: jest.fn(), getConfig: () => ({ PORT: 0 }) }));
  jest.doMock('@/infra/logger', () => ({ initLogger: jest.fn(), getLogger: () => logger }));
  jest.doMock('@/infra/postgres/client', () => ({ initPostgresPool: jest.fn(),
    closePostgresPool: async () => { events.push('postgres'); } }));
  jest.doMock('@/infra/redis/client', () => ({ initRedis: jest.fn(), closeRedis: async () => { events.push('redis'); } }));
  jest.doMock('@/infra/cron/reservation-sweeper', () => ({ startReservationSweeper: jest.fn(), stopReservationSweeper: jest.fn() }));
  jest.doMock('@/api/app', () => ({ createApp: async () => ({ listen: async () => undefined,
    close: async () => { events.push('http'); await drained; } }) }));
  const once = jest.spyOn(process, 'once').mockImplementation(((event: string, callback: () => void) => {
    if (event === 'SIGTERM') signal = callback;
    return process;
  }) as typeof process.once);
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    await import('@/main');
    await nextTurn();
    signal();
    expect(events).toEqual(['redis', 'http']);
    drain();
    await nextTurn();
    expect(events).toEqual(['redis', 'http', 'postgres']);
    expect(exit).toHaveBeenCalledWith(0);
  } finally {
    drain();
    once.mockRestore();
    exit.mockRestore();
  }
});
