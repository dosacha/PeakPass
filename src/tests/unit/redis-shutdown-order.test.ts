import { setImmediate as nextTurn } from 'timers/promises';
import { EventEmitter } from 'events';

it.each(['SIGTERM', 'SIGINT'])('gates Redis before drain and handles repeated %s until shutdown completes', async (signal) => {
  jest.resetModules();
  const events: string[] = [];
  let drain!: () => void;
  const drained = new Promise<void>((resolve) => { drain = resolve; });
  let finishOrder!: () => void;
  const orderFinished = new Promise<void>(resolve => { finishOrder = resolve; });
  let finishAdmission!: () => void;
  const admissionFinished=new Promise<void>(resolve=>{finishAdmission=resolve;});
  const signals = new EventEmitter();
  const logger = { info: jest.fn(), error: jest.fn() };
  jest.doMock('@/core/services/admission.service', () => ({assertP4AdmissionStartup:jest.fn(),admissionService:{verifyEnvironment:jest.fn()}}));
  jest.doMock('@/infra/config', () => ({ loadConfig: jest.fn(), getConfig: () => ({ PORT: 0, ENABLE_ADMISSION:true }) }));
  jest.doMock('@/infra/logger', () => ({ initLogger: jest.fn(), getLogger: () => logger }));
  jest.doMock('@/infra/postgres/client', () => ({ initPostgresPool: jest.fn(),
    closePostgresPool: async () => { events.push('postgres'); } }));
  jest.doMock('@/infra/redis/client', () => ({ initRedis: jest.fn(), closeRedis: async () => { events.push('redis'); } }));
  jest.doMock('@/infra/cron/reservation-sweeper', () => ({ startReservationSweeper: jest.fn(), stopReservationSweeper: jest.fn() }));
  jest.doMock('@/infra/cron/order-sweeper', () => ({ startOrderSweeper: () => ({ stop: () => { events.push('order-stop'); return orderFinished; } }) }));
  jest.doMock('@/infra/cron/admission-scheduler',()=>({startAdmissionScheduler:()=>({stop:()=>{events.push('admission-stop'); return admissionFinished;}})}));
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
    expect(events).toEqual(['redis', 'order-stop', 'admission-stop', 'http']);
    // Apollo re-sends the signal after its own stop while HTTP may still be draining.
    expect(signals.emit(signal)).toBe(true);
    expect(events).toEqual(['redis', 'order-stop', 'admission-stop', 'http']);
    expect(exit).not.toHaveBeenCalled();
    drain();
    await nextTurn();
    expect(events).toEqual(['redis', 'order-stop', 'admission-stop', 'http']);
    expect(exit).not.toHaveBeenCalled();
    finishOrder();
    await nextTurn();
    expect(events).toEqual(['redis', 'order-stop', 'admission-stop', 'http']);
    expect(exit).not.toHaveBeenCalled();
    finishAdmission(); await nextTurn();
    expect(events).toEqual(['redis', 'order-stop', 'admission-stop', 'http', 'postgres']);
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  } finally {
    finishOrder();
    finishAdmission();
    drain();
    await nextTurn();
    once.mockRestore();
    on.mockRestore();
    exit.mockRestore();
  }
});

it('startup listen failure fences Redis and awaits the stopped worker before closing PostgreSQL', async () => {
  jest.resetModules();
  jest.doMock('@/core/services/admission.service', () => ({assertP4AdmissionStartup:jest.fn(),admissionService:{verifyEnvironment:jest.fn()}}));
  const events: string[] = [];
  let finish!: () => void;
  const inflight = new Promise<void>(resolve => { finish = resolve; });
  let finishAdmission!:()=>void;
  const admissionFinished=new Promise<void>(resolve=>{finishAdmission=resolve;});
  jest.doMock('@/infra/config', () => ({ loadConfig: jest.fn(), getConfig: () => ({ PORT: 0,ENABLE_ADMISSION:true }) }));
  jest.doMock('@/infra/logger', () => ({ initLogger: jest.fn(), getLogger: () => ({ info: jest.fn(), error: jest.fn() }) }));
  jest.doMock('@/infra/postgres/client', () => ({ initPostgresPool: jest.fn(), closePostgresPool: async () => { events.push('postgres'); } }));
  jest.doMock('@/infra/redis/client', () => ({ initRedis: jest.fn(), closeRedis: async () => { events.push('redis'); } }));
  jest.doMock('@/infra/cron/reservation-sweeper', () => ({ startReservationSweeper: jest.fn(), stopReservationSweeper: jest.fn() }));
  jest.doMock('@/infra/cron/order-sweeper', () => ({ startOrderSweeper: () => ({ stop: () => { events.push('order-stop'); return inflight; } }) }));
  jest.doMock('@/infra/cron/admission-scheduler',()=>({startAdmissionScheduler:()=>({stop:()=>{events.push('admission-stop'); return admissionFinished;}})}));
  jest.doMock('@/api/app', () => ({ createApp: async () => ({ listen: async () => { throw new Error('listen failed'); }, close: async () => { events.push('http'); } }) }));
  const on = jest.spyOn(process, 'on').mockImplementation(() => process);
  const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    await import('@/main'); await nextTurn();
    expect(events).toEqual(['redis', 'order-stop', 'admission-stop', 'http']); expect(exit).not.toHaveBeenCalled();
    finish(); await nextTurn();
    expect(exit).not.toHaveBeenCalled();
    finishAdmission(); await nextTurn();
    expect(events).toEqual(['redis', 'order-stop', 'admission-stop', 'http', 'postgres']); expect(exit).toHaveBeenCalledWith(1);
  } finally { finish(); finishAdmission(); await nextTurn(); on.mockRestore(); exit.mockRestore(); }
});
