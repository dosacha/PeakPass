import { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { DemoSessionConfigurationError } from '@/core/errors';
import { getConfig, Config } from '@/infra/config';
import { getLogger } from '@/infra/logger';
import { getPostgresPool } from '@/infra/postgres/client';

type DemoUser = {
  id: string;
  email: string;
};

type DemoSession = {
  userId: string;
  email: string;
  token: string;
  expiresAt: string;
};

export type DemoSessionDependencies = {
  findUserByEmail?: (email: string) => Promise<DemoUser | null>;
};

export async function findDemoUserByEmail(email: string): Promise<DemoUser | null> {
  const pool = getPostgresPool();
  const result = await pool.query<DemoUser>(
    'SELECT id, email FROM users WHERE email = $1 LIMIT 1',
    [email],
  );

  return result.rows[0] ?? null;
}

export function createDemoSession(user: DemoUser, config: Config): DemoSession {
  const expiresAt = new Date(Date.now() + config.DEMO_SESSION_TTL_SECONDS * 1000).toISOString();
  const token = jwt.sign(
    { email: user.email, role: 'demo' },
    config.JWT_SECRET,
    {
      subject: user.id,
      expiresIn: config.DEMO_SESSION_TTL_SECONDS,
    },
  );

  return {
    userId: user.id,
    email: user.email,
    token,
    expiresAt,
  };
}

export async function registerDemoSessionRoutes(
  app: FastifyInstance,
  dependencies: DemoSessionDependencies = {},
) {
  const config = getConfig();
  if (!config.ENABLE_DEMO_SESSION) {
    return;
  }

  const logger = getLogger();
  const findUserByEmail = dependencies.findUserByEmail ?? findDemoUserByEmail;

  app.post('/demo/session', async (request, reply) => {
    const user = await findUserByEmail(config.DEMO_USER_EMAIL);
    if (!user) {
      throw new DemoSessionConfigurationError();
    }

    const session = createDemoSession(user, config);
    logger.info(
      { requestId: request.id, userId: user.id },
      'Issued live demo session',
    );

    return reply.header('Cache-Control', 'no-store').send(session);
  });
}
