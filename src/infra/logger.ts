import pino, { Logger as PinoLogger } from 'pino';
import { getConfig } from './config';

let logger: PinoLogger | null = null;

export function initLogger(): PinoLogger {
  if (logger) return logger;

  const config = getConfig();

  const transport = config.NODE_ENV === 'production'
    ? undefined
    : pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      });

  logger = pino(
    {
      level: config.LOG_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );

  return logger;
}

export function getLogger(): PinoLogger {
  if (!logger) {
    return initLogger();
  }
  return logger;
}

export type Logger = PinoLogger;
