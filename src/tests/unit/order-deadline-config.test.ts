import { spawnSync } from 'node:child_process';

describe('order payment window startup configuration', () => {
  // A missing/default-only parser must not permit an invalid deadline at startup.
  it.each(['0', '-1', 'wat', 'NaN', 'Infinity', '-Infinity', ''])('rejects %j before startup', (value) => {
    const result = load(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ORDER_PAYMENT_WINDOW_MINUTES');
  });

  it.each([[undefined, 10], ['3', 3], ['1.5', 1.5]] as const)('loads %j as %s minutes', (value, expected) => {
    const result = load(value);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(String(expected));
  });
});

function load(value: string | undefined) {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'test' };
  delete env.ORDER_PAYMENT_WINDOW_MINUTES;
  if (value !== undefined) env.ORDER_PAYMENT_WINDOW_MINUTES = value;
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "import {loadConfig} from './src/infra/config.ts'; console.log(JSON.stringify(loadConfig().ORDER_PAYMENT_WINDOW_MINUTES));"],
  { env, encoding: 'utf8', timeout: 10000 });
}
