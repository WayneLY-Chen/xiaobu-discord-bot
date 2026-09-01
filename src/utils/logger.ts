type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: number = LEVEL_ORDER.info;

export function setLogLevel(level: Level): void {
  threshold = LEVEL_ORDER[level];
}

function emit(level: Level, message: string, meta?: unknown): void {
  if (LEVEL_ORDER[level] < threshold) return;

  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;

  if (meta === undefined) stream(line);
  else stream(line, meta);
}

export const logger = {
  debug: (message: string, meta?: unknown) => emit('debug', message, meta),
  info: (message: string, meta?: unknown) => emit('info', message, meta),
  warn: (message: string, meta?: unknown) => emit('warn', message, meta),
  error: (message: string, meta?: unknown) => emit('error', message, meta),
};
