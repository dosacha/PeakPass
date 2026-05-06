const ORIGINAL_ENV = process.env;

const VALID_PRODUCTION_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  JWT_SECRET: 'j'.repeat(32),
  API_KEY: 'prod-api-key',
  WEBHOOK_SIGNING_SECRET: 'prod-webhook-signing-secret',
  ENFORCE_AUTH_USER_MATCH: 'true',
  RATE_LIMIT_FAIL_MODE: 'closed',
  ENABLE_RATE_LIMITING: 'true',
};

async function loadConfigWithEnv(env: NodeJS.ProcessEnv) {
  jest.resetModules();
  process.env = { ...env };

  const { loadConfig } = await import('@/infra/config');
  return loadConfig();
}

function mockProcessExit() {
  return jest.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit:${code}`);
  }) as typeof process.exit);
}

describe('production config invariants', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('blocks one-character JWT_SECRET before production boot', async () => {
    const exitSpy = mockProcessExit();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      loadConfigWithEnv({
        ...VALID_PRODUCTION_ENV,
        JWT_SECRET: 'x',
      }),
    ).rejects.toThrow('process.exit:1');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('accepts a 32-character JWT_SECRET boundary', async () => {
    const config = await loadConfigWithEnv({
      ...VALID_PRODUCTION_ENV,
      JWT_SECRET: 's'.repeat(32),
    });

    expect(config.JWT_SECRET).toHaveLength(32);
  });

  it('blocks ENABLE_RATE_LIMITING=false in production', async () => {
    await expect(
      loadConfigWithEnv({
        ...VALID_PRODUCTION_ENV,
        ENABLE_RATE_LIMITING: 'false',
      }),
    ).rejects.toThrow('ENABLE_RATE_LIMITING must be true in production environment');
  });

  it('allows ENABLE_RATE_LIMITING=false outside production', async () => {
    const config = await loadConfigWithEnv({
      NODE_ENV: 'development',
      JWT_SECRET: 'd'.repeat(32),
      ENABLE_RATE_LIMITING: 'false',
    });

    expect(config.ENABLE_RATE_LIMITING).toBe(false);
  });
});
