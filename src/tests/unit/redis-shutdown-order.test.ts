import { setImmediate as nextTurn } from 'timers/promises';
import { EventEmitter } from 'events';

it.each(['SIGTERM', 'SIGINT'])('gates Redis before drain and handles repeated %s until shutdown completes', async (signal) => {
  jest.resetModules();
  const events: string[] = [];
  let drain!: () => void;
  const drained = new Promise<void>((resolve) => { drain = resolve; });
  const signals = new EventEmitter();
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
    signals.once(event, callback);
    return process;
  }) as typeof process.once);
  const on = jest.spyOn(process, 'on').mockImplementation(((event: string, callback: () => void) => {
    signals.on(event, callback);
    return process;
  }) as typeof process.on);
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    await import('@/main');
    await nextTurn();
    expect(signals.emit(signal)).toBe(true);
    expect(events).toEqual(['redis', 'http']);
    // Apollo re-sends the signal after its own stop while HTTP may still be draining.
    expect(signals.emit(signal)).toBe(true);
    expect(events).toEqual(['redis', 'http']);
    expect(exit).not.toHaveBeenCalled();
    drain();
    await nextTurn();
    expect(events).toEqual(['redis', 'http', 'postgres']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  } finally {
    drain();
    await nextTurn();
    once.mockRestore();
    on.mockRestore();
    exit.mockRestore();
  }
});
