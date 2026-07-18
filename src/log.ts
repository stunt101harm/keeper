import pino from 'pino';

const pretty = process.env.LOG_PRETTY === 'true' || process.stdout.isTTY;

export const log = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss.l' } } }
    : {}),
});
