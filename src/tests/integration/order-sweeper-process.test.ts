import { spawn, ChildProcess } from 'child_process';
import type { Pool } from 'pg';
import { initPostgresPool, closePostgresPool } from '@/infra/postgres/client';
import { fixture, until } from './order-sweeper-fixture';

jest.setTimeout(30000);
describe('order sweeper actual application processes', () => {
  let pool: Pool;
  let data: Awaited<ReturnType<typeof fixture>>;
  let child: ChildProcess | undefined;
  beforeAll(async () => { pool = await initPostgresPool(); });
  beforeEach(async () => { data = await fixture(pool); });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child!.once('exit', resolve)); child.kill('SIGKILL'); await exited;
    }
    await data.cleanup();
  });
  afterAll(async () => { await closePostgresPool(); });

  it('starts overdue catch-up immediately without waiting for the configured interval', async () => {
    await data.order();
    let output = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      env: { ...process.env, PORT: '0', LOG_LEVEL: 'info', ORDER_SWEEP_INTERVAL_MS: '60000' }, windowsHide: true,
    });
    child.stdout!.on('data', chunk => { output += String(chunk); });
    child.stderr!.on('data', chunk => { output += String(chunk); });
    expect(await until(async () => output.includes('서버 실행 시작'))).toBe(true);
    await until(async () => (await data.state())[0]?.status === 'expired', 1500);
    expect((await data.state())[0]).toMatchObject({ status: 'expired', available_seats: 10000, tickets: 0 });
  });
});
