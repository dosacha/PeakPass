const ORIGINAL_ENV = process.env;

const VALID_PRODUCTION_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  JWT_SECRET: 'j'.repeat(32),
  WEBHOOK_SIGNING_SECRET: 'w'.repeat(32),
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

  it('starts with the valid production environment the other cases change one value of', async () => {
    const config = await loadConfigWithEnv(VALID_PRODUCTION_ENV);

    expect(config.NODE_ENV).toBe('production');
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

  // One case for every branch of assertProductionInvariants. `undefined` removes the variable.
  it.each<[string, NodeJS.ProcessEnv, string]>([
    [
      'the built-in development JWT_SECRET',
      { JWT_SECRET: undefined },
      'JWT_SECRET must be set in production environment',
    ],
    [
      'a missing WEBHOOK_SIGNING_SECRET',
      { WEBHOOK_SIGNING_SECRET: undefined },
      'WEBHOOK_SIGNING_SECRET must be set in production environment',
    ],
    [
      'a blank WEBHOOK_SIGNING_SECRET',
      { WEBHOOK_SIGNING_SECRET: '   ' },
      'WEBHOOK_SIGNING_SECRET must be set in production environment',
    ],
    [
      'a 31-character WEBHOOK_SIGNING_SECRET',
      { WEBHOOK_SIGNING_SECRET: 'w'.repeat(31) },
      'WEBHOOK_SIGNING_SECRET must be at least 32 characters in production environment',
    ],
    [
      'ENFORCE_AUTH_USER_MATCH=false',
      { ENFORCE_AUTH_USER_MATCH: 'false' },
      'ENFORCE_AUTH_USER_MATCH must be true in production environment',
    ],
    [
      'RATE_LIMIT_FAIL_MODE=open',
      { RATE_LIMIT_FAIL_MODE: 'open' },
      'RATE_LIMIT_FAIL_MODE must be "closed" in production environment',
    ],
    [
      'ENABLE_RATE_LIMITING=false',
      { ENABLE_RATE_LIMITING: 'false' },
      'ENABLE_RATE_LIMITING must be true in production environment',
    ],
  ])('blocks %s in production', async (_name, change, message) => {
    await expect(loadConfigWithEnv({ ...VALID_PRODUCTION_ENV, ...change })).rejects.toThrow(
      message,
    );
  });

  it('applies none of the production checks outside production', async () => {
    const config = await loadConfigWithEnv({
      NODE_ENV: 'development',
      ENABLE_RATE_LIMITING: 'false',
      ENFORCE_AUTH_USER_MATCH: 'false',
      RATE_LIMIT_FAIL_MODE: 'open',
    });

    expect(config.ENABLE_RATE_LIMITING).toBe(false);
    expect(config.WEBHOOK_SIGNING_SECRET).toBeUndefined();
  });
});
