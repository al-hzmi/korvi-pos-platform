import { z } from 'zod';

/**
 * Environment parsing, once, at the edge.
 *
 * Everything downstream receives a typed object rather than reading
 * process.env, so a missing variable fails at boot with a clear message
 * instead of surfacing as `undefined` inside a request three hours later.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    /**
     * Where the browser app is served from, comma-separated, exact origins.
     *
     * Used for the origin check on state-changing requests. Required in
     * production and absent by default, so a deployment that forgets it fails
     * to boot rather than accepting writes from anywhere (ADR-0012).
     */
    APP_ORIGINS: z.string().optional(),

    SESSION_TTL_HOURS: z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 30)
      .default(12),

    /** Absent is legal: a server with no database still answers /health. */
    DATABASE_URL: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && (value.APP_ORIGINS ?? '').trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['APP_ORIGINS'],
        message: 'is required in production; refusing to accept writes from an unknown origin',
      });
    }
  });

export interface ApiConfig {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly API_PORT: number;
  readonly LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly APP_ORIGINS: readonly string[];
  readonly SESSION_TTL_SECONDS: number;
  readonly DATABASE_URL: string | undefined;
  readonly isProduction: boolean;
}

/** Development convenience only; production has no default and never gets one. */
const DEVELOPMENT_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  const value = parsed.data;
  const configured = (value.APP_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');

  return {
    NODE_ENV: value.NODE_ENV,
    API_PORT: value.API_PORT,
    LOG_LEVEL: value.LOG_LEVEL,
    APP_ORIGINS: configured.length > 0 ? configured : DEVELOPMENT_ORIGINS,
    SESSION_TTL_SECONDS: value.SESSION_TTL_HOURS * 3600,
    DATABASE_URL: value.DATABASE_URL,
    isProduction: value.NODE_ENV === 'production',
  };
}
