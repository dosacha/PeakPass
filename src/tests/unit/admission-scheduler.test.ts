import { startAdmissionScheduler } from '@/infra/cron/admission-scheduler';
import { reclaimOverdueClaims } from '@/core/services/admission-consumption';

it('stops scheduling immediately and drains the one in-flight admission tick', async () => {
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const service = { maintain: jest.fn(() => blocked), stop: jest.fn() };
  const worker = startAdmissionScheduler(service, 1);
  expect(service.maintain).toHaveBeenCalledTimes(1);
  // The tick hands overdue claims to the ledger-backed reclaimer.
  expect(service.maintain).toHaveBeenCalledWith(expect.any(Function), reclaimOverdueClaims);
  let stopped = false;
  const drain = worker.stop().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish();
  await drain;
  // A tick that ends after stop() must not schedule the next one. The interval is 1 ms,
  // so a scheduler that kept going would have called maintain many times by now.
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(service.maintain).toHaveBeenCalledTimes(1);
  expect(service.stop).toHaveBeenCalledTimes(1);
});
