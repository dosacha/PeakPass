import 'dotenv/config';
import { z } from 'zod';

// 환경변수에서 boolean을 안전하게 읽는다.
// `z.coerce.boolean()`은 자바스크립트 `Boolean(string)` 룰을 따라
// 빈 문자열을 제외한 모든 string("false"·"0"·"FALSE" 등)을 true로 변환하는 함정이 있다.
// 실제 운영에서 ENABLE_RATE_LIMITING=false로 끄려고 해도 안 꺼지는 *진짜 버그*였다.
// 명시적 파서로 "true"/"1"만 true로, "false"/"0"은 false로 정확히 매핑한다.
//
// export하는 이유: 테스트가 inline 재정의 대신 production parser를 직접 검증하도록 함.
export const booleanFromEnv = (defaultValue: boolean) =>
  z
    .union([z.string(), z.boolean(), z.undefined()])
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      if (v === undefined || v === '') return defaultValue;
      const normalized = v.toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
      return defaultValue;
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  PORT: z.coerce.number().default(3000),

  // 데이터베이스 설정
  DATABASE_URL: z.string().default('postgresql://peakpass:peakpass@localhost:5432/peakpass'),
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().default(5432),
  DB_USER: z.string().default('peakpass'),
  DB_PASSWORD: z.string().default('peakpass'),
  DB_NAME: z.string().default('peakpass'),
  DB_POOL_MIN: z.coerce.number().default(2),
  DB_POOL_MAX: z.coerce.number().default(10),

  // Redis 설정
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_POOL_SIZE: z.coerce.number().default(10),

  // 애플리케이션 설정
  JWT_SECRET: z.string().default('dev-secret-change-in-production'),
  API_KEY: z.string().default('dev-api-key-change-in-production'),

  // 외부 서비스 설정
  PAYMENT_SERVICE_URL: z.string().url().default('https://api.payment-provider.example.com'),
  PAYMENT_API_KEY: z.string().default('test-key-change-in-production'),
  WEBHOOK_SIGNING_SECRET: z.string().optional(),
  // webhook timestamp ± 허용 범위 (초). default 5분 (Stripe 권장값과 동일).
  WEBHOOK_REPLAY_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),

  // 기능 플래그
  ENABLE_RATE_LIMITING: booleanFromEnv(true),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(5),
  // Redis 장애 시 동작:
  //   - 'closed' (default): 요청 거부 (보안 우선, 운영 권장)
  //   - 'open': 요청 통과 (가용성 우선, 비핵심 경로용)
  RATE_LIMIT_FAIL_MODE: z.enum(['open', 'closed']).default('closed'),

  // 인증 정책:
  //   - true: JWT 미존재 시 401, JWT subject != body.userId 시 403
  //   - false: JWT 있을 때만 일치 강제, 없으면 body 신뢰 + warn 로그 (demo override)
  ENFORCE_AUTH_USER_MATCH: booleanFromEnv(true),

  // GraphQL query 복잡도 상한.
  // didResolveOperation 단계에서 계산된 complexity가 이 값을 초과하면 거부한다.
  // 의도: 악의/실수로 들어오는 깊은 nested query 또는 큰 limit 인자로 인한 DB 폭주 방어.
  GRAPHQL_MAX_COMPLEXITY: z.coerce.number().int().positive().default(5000),
});

export type Config = z.infer<typeof envSchema>;

let cachedConfig: Config | null = null;

/**
 * production 환경에서 절대 켜지면 안 되는 설정 조합을 검증한다.
 *
 * 실패 정책: throw해서 부팅을 막는다. fail-fast가 silent로 보안 토글이
 * 잘못 켜진 채 트래픽을 받는 것보다 안전하다.
 */
function assertProductionInvariants(config: Config): void {
  if (config.NODE_ENV !== 'production') {
    return;
  }

  if (config.JWT_SECRET === 'dev-secret-change-in-production') {
    throw new Error('JWT_SECRET must be set in production environment');
  }

  if (config.API_KEY === 'dev-api-key-change-in-production') {
    throw new Error('API_KEY must be set in production environment');
  }

  // WEBHOOK_SIGNING_SECRET이 미설정이면 webhook-signature 미들웨어가 검증을 skip한다.
  // production에서는 fail-open이 보안 사고로 직결되므로 fail-fast로 강제한다.
  if (!config.WEBHOOK_SIGNING_SECRET || config.WEBHOOK_SIGNING_SECRET.trim().length === 0) {
    throw new Error(
      'WEBHOOK_SIGNING_SECRET must be set in production environment ' +
        '(missing secret would cause webhook signature verification to silently skip)',
    );
  }

  // ENFORCE_AUTH_USER_MATCH=false는 body의 userId를 무인증 신뢰하는 demo override다.
  // production에서 이 토글이 켜져 있으면 JWT 없이 임의 userId로 reservation/checkout이
  // 통과하는 인증 우회가 된다. 환경변수 한 줄 잘못 박는 사고를 막기 위해 fail-fast.
  if (!config.ENFORCE_AUTH_USER_MATCH) {
    throw new Error(
      'ENFORCE_AUTH_USER_MATCH must be true in production environment ' +
        '(false trusts body.userId without JWT, causing authentication bypass)',
    );
  }

  // RATE_LIMIT_FAIL_MODE=open은 Redis 장애 시 rate limit layer를 사실상 제거한다.
  // production의 결제 경로에서 폭주 방어 layer가 사라지면 oversell·결제 중복 위험이
  // 직접 커지므로, fail-closed를 강제한다. 비핵심 read API에만 open을 허용하려면
  // 별도 환경변수로 분기해야 한다 (현재는 단일 토글).
  if (config.RATE_LIMIT_FAIL_MODE !== 'closed') {
    throw new Error(
      'RATE_LIMIT_FAIL_MODE must be "closed" in production environment ' +
        '(open mode disables rate limiting on Redis failure, exposing checkout/webhook to flooding)',
    );
  }
}

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten());
    process.exit(1);
  }

  const config = result.data;

  assertProductionInvariants(config);

  cachedConfig = config;
  return cachedConfig;
}

export function getConfig(): Config {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}