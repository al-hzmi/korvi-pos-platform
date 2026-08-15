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

    /**
     * The key that signs an initial-owner bootstrap capability.
     *
     * Configuration, never a column: a signing key in the database is a signing
     * key in every backup, and the whole point of the capability is that only
     * this process can mint one (ADR-0021).
     *
     * Absent is legal outside production — a deployment that has not enabled
     * bootstrap answers 503 on that one route and works normally everywhere
     * else. Required in production, where serving the route unsigned or
     * discovering the gap on the first invitation are both worse than refusing
     * to boot.
     *
     * The 32-character floor is a **length** check and nothing more. It catches
     * `secret` and `changeme`; it cannot tell a CSPRNG's 32 bytes from a
     * memorable sentence of the same length, and no schema can. A production
     * `BOOTSTRAP_SIGNING_KEY` must be generated from a cryptographically secure
     * random source — `openssl rand -base64 48`, or the platform's secret
     * manager — and handled as a secret: injected as an environment variable,
     * never committed, never logged, rotated by re-issuing outstanding
     * invitations. That is a deployment obligation, and this floor is only the
     * part of it a boot-time check is capable of enforcing (ADR-0021).
     */
    BOOTSTRAP_SIGNING_KEY: z.string().min(32).max(512).optional(),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && (value.BOOTSTRAP_SIGNING_KEY ?? '').trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['BOOTSTRAP_SIGNING_KEY'],
        message:
          'is required in production; owner bootstrap cannot be served without a signing key',
      });
    }
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
  /** Never logged, never echoed, never persisted. */
  readonly BOOTSTRAP_SIGNING_KEY: string | undefined;
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
    BOOTSTRAP_SIGNING_KEY: value.BOOTSTRAP_SIGNING_KEY,
    isProduction: value.NODE_ENV === 'production',
  };
}
