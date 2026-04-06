import { initPostgresPool, getPostgresPool } from '@/infra/postgres/client';
import { loadConfig } from '@/infra/config';
import { initLogger, getLogger } from '@/infra/logger';
import { v4 as uuid } from 'uuid';

type SeedUserRow = {
  id: string;
  email: string;
};

type SeedEventRow = {
  id: string;
  name: string;
};

async function seedDatabase() {
  loadConfig();
  initLogger();
  await initPostgresPool();

  const pool = getPostgresPool();
  const logger = getLogger();

  try {
    logger.info('Seeding database...');

    // 테스트 사용자 생성
    await pool.query(
      `
      INSERT INTO users (id, email, name) VALUES
      ($1, 'user1@example.com', 'User One'),
      ($2, 'user2@example.com', 'User Two'),
      ($3, 'user3@example.com', 'User Three')
      ON CONFLICT DO NOTHING
      `,
      [uuid(), uuid(), uuid()],
    );

    const userResult = await pool.query<SeedUserRow>(
      `
      SELECT id, email
      FROM users
      WHERE email IN ('user1@example.com', 'user2@example.com', 'user3@example.com')
      ORDER BY email ASC
      `,
    );

    const userMap = new Map(userResult.rows.map((user) => [user.email, user.id]));

    logger.info('테스트 사용자 생성됨');

    // 테스트 이벤트 생성
    const pricingTier1 = {
      id: uuid(),
      name: 'General Admission',
      price: 50,
      quantity: 100,
    };

    const pricingTier2 = {
      id: uuid(),
      name: 'Premium',
      price: 100,
      quantity: 50,
    };

    const now = new Date();
    const startsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);

    await pool.query(
      `
      INSERT INTO events (id, name, description, starts_at, ends_at, total_seats, available_seats, pricing, status)
      VALUES
      ($1, 'Node.js Workshop', 'Learn Node.js from scratch', $3, $4, 100, 100, $5, 'published'),
      ($2, 'Advanced GraphQL', 'Deep dive into GraphQL patterns', $3, $4, 50, 50, $6, 'published')
      ON CONFLICT DO NOTHING
      `,
      [
        uuid(),
        uuid(),
        startsAt,
        endsAt,
        JSON.stringify([pricingTier1]),
        JSON.stringify([pricingTier2]),
      ],
    );

    const eventResult = await pool.query<SeedEventRow>(
      `
      SELECT id, name
      FROM events
      WHERE name IN ('Node.js Workshop', 'Advanced GraphQL')
      ORDER BY created_at DESC
      `,
    );

    const latestEventByName = new Map<string, string>();
    for (const event of eventResult.rows) {
      if (!latestEventByName.has(event.name)) {
        latestEventByName.set(event.name, event.id);
      }
    }

    logger.info('테스트 이벤트 생성됨');
    logger.info(`
      이벤트 1: ${latestEventByName.get('Node.js Workshop')}
        - 이름: Node.js Workshop
        - 자리: 100
        - 가격: $50 (일반 입장료)

      이벤트 2: ${latestEventByName.get('Advanced GraphQL')}
        - 이름: Advanced GraphQL
        - 자리: 50
        - 가격: $100 (프리미엄)

      사용자:
        - ${userMap.get('user1@example.com')}: user1@example.com
        - ${userMap.get('user2@example.com')}: user2@example.com
        - ${userMap.get('user3@example.com')}: user3@example.com
    `);

    await pool.end();
    logger.info('Seeding complete');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Seeding failed');
    process.exit(1);
  }
}

seedDatabase();
