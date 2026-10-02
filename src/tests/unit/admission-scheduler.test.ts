import { existsSync } from 'fs';

it('stops scheduling immediately and drains the one in-flight admission tick', async () => {
  expect(existsSync('src/infra/cron/admission-scheduler.ts')).toBe(true);
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = { maintain: jest.fn(() => blocked), stop: jest.fn() };
  const modulePath = '@/infra/cron/admission-scheduler';
  const { startAdmissionScheduler } = await import(modulePath);
  const worker = startAdmissionScheduler(service, 1);
  expect(service.maintain).toHaveBeenCalledTimes(1);
  // The tick hands overdue claims to P5's ledger-backed reclaimer.
  const { reclaimOverdueClaims } = await import('@/core/services/admission-consumption');
  expect(service.maintain).toHaveBeenCalledWith(expect.any(Function), reclaimOverdueClaims);
  let stopped = false;
  const drain = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish();
  await drain;
  expect(service.maintain).toHaveBeenCalledTimes(1);
  expect(service.stop).toHaveBeenCalledTimes(1);
});
