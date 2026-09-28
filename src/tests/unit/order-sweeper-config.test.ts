import { spawnSync } from 'child_process';
it.each(['ORDER_SWEEP_INTERVAL_MS', 'ORDER_SWEEP_BATCH_SIZE'])('%s rejects invalid scheduling configuration at startup', key => {
  for (const value of ['0', '-1', '1.5', 'wat', 'NaN', 'Infinity', '']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import {loadConfig} from './src/infra/config.ts'; loadConfig();"], {
      env: { ...process.env, NODE_ENV: 'test', [key]: value }, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    expect({ value, status: result.status }).toEqual({ value, status: 1 });
    expect(result.stderr).toContain(key);
  }
}, 30000);

it('loads operator-selected worker values and rejects a Node timer overflow', () => {
  const run = (interval: string) => spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import {loadConfig} from './src/infra/config.ts'; const c=loadConfig(); console.log(JSON.stringify([c.ORDER_SWEEP_INTERVAL_MS,c.ORDER_SWEEP_BATCH_SIZE]));"],
  { env: { ...process.env, NODE_ENV: 'test', ORDER_SWEEP_INTERVAL_MS: interval, ORDER_SWEEP_BATCH_SIZE: '7' }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  const valid = run('1234');
  expect(valid.status).toBe(0); expect(JSON.parse(valid.stdout)).toEqual([1234, 7]);
  expect(run('2147483648').status).toBe(1);
});
