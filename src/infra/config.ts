import 'dotenv/config';
import { z } from 'zod';

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
  
  // 기능 플래그
  ENABLE_RATE_LIMITING: z.coerce.boolean().default(true),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(5),
});

export type Config = z.infer<typeof envSchema>;

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten());
    process.exit(1);
  }

  const config = result.data;

  // 운영 환경 시크릿 검증
  if (config.NODE_ENV === 'production') {
    if (config.JWT_SECRET === 'dev-secret-change-in-production') {
      throw new Error('JWT_SECRET must be set in production environment');
    }
    if (config.API_KEY === 'dev-api-key-change-in-production') {
      throw new Error('API_KEY must be set in production environment');
    }
  }

  cachedConfig = config;
  return cachedConfig;
}

export function getConfig(): Config {
  if (!cachedConfig) {
    return loadConfig();
  }
  return cachedConfig;
}
