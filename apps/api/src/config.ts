import { z } from 'zod';

/**
 * Production secrets that the runtime refuses to start without.
 *
 * Deployment-contract verification reads this declaration and requires the
 * staging Blueprint to provision every member independently. Keep this list in
 * lock-step with the production boot checks below: adding a new mandatory
 * secret must make an unprepared deployment fail before it can reach staging.
 */
export const PRODUCTION_REQUIRED_SECRET_ENV_KEYS = [
  'BOOTSTRAP_SIGNING_KEY',
  'METRICS_AUTH_TOKEN',
  'OFFLINE_LEASE_SIGNING_SEED_B64',
] as const;

function configuredOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

function isExactHttpsOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin;
  } catch {
    return false;
  }
}

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

    /**
     * Unauthenticated-login admission controls. These budgets are process-local
     * by design: the API must protect its own CPU/thread-pool even if an outer
     * edge limiter is missing or bypassed. They are tunable for production
     * capacity, but every value is bounded and validated at boot.
     */
    AUTH_LOGIN_GLOBAL_LIMIT: z.coerce.number().int().min(10).max(10_000).default(120),
    AUTH_LOGIN_IDENTITY_LIMIT: z.coerce.number().int().min(1).max(1_000).default(10),
    AUTH_LOGIN_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3_600).default(60),
    AUTH_LOGIN_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(2),
    AUTH_LOGIN_MAX_TRACKED_IDENTITIES: z.coerce.number().int().min(64).max(100_000).default(4_096),

    /**
     * Optional outside production so local health-only/test processes remain
     * useful. Production refuses to boot without the authoritative database:
     * a liveness-only platform check must never advertise an unusable ERP API.
     */
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

    /**
     * Bearer credential for the machine-only Prometheus scrape surface.
     *
     * It never enters application persistence and must come from the deployment
     * secret manager. Production refuses to boot without it: an ERP that ships
     * an unauthenticated metrics surface, or silently ships no production
     * telemetry at all, is an operations defect rather than a runtime default.
     */
    METRICS_AUTH_TOKEN: z.string().min(32).max(512).optional(),

    /** Ed25519 seed for server-signed installed-cashier offline authority. Never ships to clients. */
    OFFLINE_LEASE_SIGNING_SEED_B64: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .optional(),
    OFFLINE_LEASE_KEY_ID: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/)
      .optional(),
    OFFLINE_LEASE_TTL_HOURS: z.coerce
      .number()
      .int()
      .min(12)
      .max(24 * 7)
      .default(72),

    /**
     * Korvi's own SaaS control-plane realm. It is intentionally independent
     * from merchant users and merchant sessions: a platform operator is not a
     * user inside any tenant. The access key authenticates the login request;
     * a separate key signs the short-lived HttpOnly platform session cookie.
     * All three values are optional as a unit so deployments that have not yet
     * enabled the internal platform surface fail that route closed with 503.
     */
    PLATFORM_ADMIN_ACCESS_KEY: z.string().min(32).max(512).optional(),
    PLATFORM_SESSION_SIGNING_KEY: z.string().min(32).max(512).optional(),
    PLATFORM_ADMIN_ACTOR_REF: z.string().min(1).max(120).optional(),
    PLATFORM_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(4),
  })
  .superRefine((value, context) => {
    const bootstrapSigningKey = value.BOOTSTRAP_SIGNING_KEY;
    const metricsAuthToken = value.METRICS_AUTH_TOKEN;
    const platformAccessKey = value.PLATFORM_ADMIN_ACCESS_KEY;
    const platformSigningKey = value.PLATFORM_SESSION_SIGNING_KEY;
    const platformActorRef = value.PLATFORM_ADMIN_ACTOR_REF;
    const offlineSeed = value.OFFLINE_LEASE_SIGNING_SEED_B64;
    const offlineKeyId = value.OFFLINE_LEASE_KEY_ID;
    const platformConfigured = [platformAccessKey, platformSigningKey, platformActorRef].filter(
      (item) => item !== undefined,
    ).length;

    if (value.AUTH_LOGIN_IDENTITY_LIMIT > value.AUTH_LOGIN_GLOBAL_LIMIT) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_LOGIN_IDENTITY_LIMIT'],
        message: 'cannot exceed AUTH_LOGIN_GLOBAL_LIMIT',
      });
    }

    if (platformConfigured !== 0 && platformConfigured !== 3) {
      context.addIssue({
        code: 'custom',
        path: ['PLATFORM_ADMIN_ACCESS_KEY'],
        message:
          'PLATFORM_ADMIN_ACCESS_KEY, PLATFORM_SESSION_SIGNING_KEY and PLATFORM_ADMIN_ACTOR_REF must be configured together',
      });
    }
    if (
      platformAccessKey !== undefined &&
      platformSigningKey !== undefined &&
      platformAccessKey === platformSigningKey
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PLATFORM_SESSION_SIGNING_KEY'],
        message: 'must be independent from PLATFORM_ADMIN_ACCESS_KEY',
      });
    }
    for (const [key, raw] of [
      ['PLATFORM_ADMIN_ACCESS_KEY', platformAccessKey],
      ['PLATFORM_SESSION_SIGNING_KEY', platformSigningKey],
      ['PLATFORM_ADMIN_ACTOR_REF', platformActorRef],
    ] as const) {
      if (raw !== undefined && raw !== raw.trim()) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: 'must be canonical without leading or trailing whitespace',
        });
      }
    }

    if (value.NODE_ENV === 'production' && (bootstrapSigningKey ?? '').trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['BOOTSTRAP_SIGNING_KEY'],
        message:
          'is required in production; owner bootstrap cannot be served without a signing key',
      });
    }

    const origins = configuredOrigins(value.APP_ORIGINS);
    if (value.NODE_ENV === 'production' && origins.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['APP_ORIGINS'],
        message: 'is required in production; refusing to accept writes from an unknown origin',
      });
    }

    const offlineConfigured = [offlineSeed, offlineKeyId].filter(
      (item) => item !== undefined,
    ).length;
    if (offlineConfigured !== 0 && offlineConfigured !== 2) {
      context.addIssue({
        code: 'custom',
        path: ['OFFLINE_LEASE_SIGNING_SEED_B64'],
        message:
          'OFFLINE_LEASE_SIGNING_SEED_B64 and OFFLINE_LEASE_KEY_ID must be configured together',
      });
    }
    if (value.NODE_ENV === 'production' && offlineSeed === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['OFFLINE_LEASE_SIGNING_SEED_B64'],
        message:
          'is required in production; installed cashiers need bounded signed offline authority',
      });
    }
    if (value.NODE_ENV === 'production' && offlineKeyId === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['OFFLINE_LEASE_KEY_ID'],
        message: 'is required in production so offline signing authority can be rotated explicitly',
      });
    }

    if (value.NODE_ENV === 'production' && (metricsAuthToken ?? '').trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['METRICS_AUTH_TOKEN'],
        message: 'is required in production; operations telemetry must be authenticated',
      });
    }

    const databaseUrl = value.DATABASE_URL;
    if (value.NODE_ENV === 'production' && (databaseUrl ?? '').trim() === '') {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message:
          'is required in production; refusing to advertise a live API without its authoritative database',
      });
    }

    if (value.NODE_ENV !== 'production') return;

    if (origins.some((origin) => !isExactHttpsOrigin(origin))) {
      context.addIssue({
        code: 'custom',
        path: ['APP_ORIGINS'],
        message: 'must contain exact HTTPS origins only',
      });
    }
    if (new Set(origins).size !== origins.length) {
      context.addIssue({
        code: 'custom',
        path: ['APP_ORIGINS'],
        message: 'must not contain duplicate origins',
      });
    }
    if (databaseUrl !== undefined && databaseUrl !== databaseUrl.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'must be canonical without leading or trailing whitespace',
      });
    }
    if (bootstrapSigningKey !== undefined && bootstrapSigningKey !== bootstrapSigningKey.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['BOOTSTRAP_SIGNING_KEY'],
        message: 'must be a canonical secret without leading or trailing whitespace',
      });
    }
    if (metricsAuthToken !== undefined && metricsAuthToken !== metricsAuthToken.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['METRICS_AUTH_TOKEN'],
        message: 'must be a canonical secret without leading or trailing whitespace',
      });
    }
    const productionCredentials = [
      ['BOOTSTRAP_SIGNING_KEY', bootstrapSigningKey],
      ['METRICS_AUTH_TOKEN', metricsAuthToken],
      ['OFFLINE_LEASE_SIGNING_SEED_B64', offlineSeed],
      ['PLATFORM_ADMIN_ACCESS_KEY', platformAccessKey],
      ['PLATFORM_SESSION_SIGNING_KEY', platformSigningKey],
    ] as const;
    for (let left = 0; left < productionCredentials.length; left += 1) {
      const [leftKey, leftValue] = productionCredentials[left]!;
      if (leftValue === undefined) continue;
      for (let right = left + 1; right < productionCredentials.length; right += 1) {
        const [rightKey, rightValue] = productionCredentials[right]!;
        if (rightValue === undefined || leftValue !== rightValue) continue;
        // This pair is already rejected above in every environment. Avoid
        // adding a duplicate production validation issue for the same mistake.
        if (
          leftKey === 'PLATFORM_ADMIN_ACCESS_KEY' &&
          rightKey === 'PLATFORM_SESSION_SIGNING_KEY'
        ) {
          continue;
        }
        context.addIssue({
          code: 'custom',
          path: [rightKey],
          message: `must be independent from ${leftKey}; security domains cannot share a production secret`,
        });
      }
    }
  });

export interface ApiConfig {
  readonly NODE_ENV: 'development' | 'test' | 'production';
  readonly API_PORT: number;
  readonly LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  readonly APP_ORIGINS: readonly string[];
  readonly SESSION_TTL_SECONDS: number;
  /**
   * `loadConfig` always resolves all five admission controls. They remain
   * optional on this transport type only for old, hand-built NODE_ENV=test
   * fixtures that do not exercise admission itself. `registerAuthRoutes`
   * accepts the all-absent shape only in test and fails closed for production
   * or any partial override, so no deployed runtime can inherit this seam.
   */
  readonly AUTH_LOGIN_GLOBAL_LIMIT?: number;
  readonly AUTH_LOGIN_IDENTITY_LIMIT?: number;
  readonly AUTH_LOGIN_WINDOW_MS?: number;
  readonly AUTH_LOGIN_MAX_CONCURRENT?: number;
  readonly AUTH_LOGIN_MAX_TRACKED_IDENTITIES?: number;
  readonly DATABASE_URL: string | undefined;
  /** Never logged, never echoed, never persisted. */
  readonly BOOTSTRAP_SIGNING_KEY: string | undefined;
  /** Machine-only scrape credential; never logged, echoed or persisted. */
  readonly METRICS_AUTH_TOKEN: string | undefined;
  readonly OFFLINE_LEASE_SIGNING_SEED_B64: string | undefined;
  readonly OFFLINE_LEASE_KEY_ID: string | undefined;
  readonly OFFLINE_LEASE_TTL_SECONDS: number;
  /** Internal SaaS operator credential; never persisted or echoed. */
  readonly PLATFORM_ADMIN_ACCESS_KEY: string | undefined;
  /** Independent HMAC key for the HttpOnly platform session. */
  readonly PLATFORM_SESSION_SIGNING_KEY: string | undefined;
  /** Opaque actor recorded by lifecycle/commercial audit rows. */
  readonly PLATFORM_ADMIN_ACTOR_REF: string | undefined;
  readonly PLATFORM_SESSION_TTL_SECONDS: number;
  readonly isProduction: boolean;
  /** Selected only by the executable entrypoint; never by a public feature flag. */
  readonly checkoutFiscalizationMode: 'disabled' | 'production' | 'simulation';
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
  const configured = configuredOrigins(value.APP_ORIGINS);

  return {
    NODE_ENV: value.NODE_ENV,
    API_PORT: value.API_PORT,
    LOG_LEVEL: value.LOG_LEVEL,
    APP_ORIGINS: configured.length > 0 ? configured : DEVELOPMENT_ORIGINS,
    SESSION_TTL_SECONDS: value.SESSION_TTL_HOURS * 3600,
    AUTH_LOGIN_GLOBAL_LIMIT: value.AUTH_LOGIN_GLOBAL_LIMIT,
    AUTH_LOGIN_IDENTITY_LIMIT: value.AUTH_LOGIN_IDENTITY_LIMIT,
    AUTH_LOGIN_WINDOW_MS: value.AUTH_LOGIN_WINDOW_SECONDS * 1_000,
    AUTH_LOGIN_MAX_CONCURRENT: value.AUTH_LOGIN_MAX_CONCURRENT,
    AUTH_LOGIN_MAX_TRACKED_IDENTITIES: value.AUTH_LOGIN_MAX_TRACKED_IDENTITIES,
    DATABASE_URL: value.DATABASE_URL,
    BOOTSTRAP_SIGNING_KEY: value.BOOTSTRAP_SIGNING_KEY,
    METRICS_AUTH_TOKEN: value.METRICS_AUTH_TOKEN,
    OFFLINE_LEASE_SIGNING_SEED_B64: value.OFFLINE_LEASE_SIGNING_SEED_B64,
    OFFLINE_LEASE_KEY_ID: value.OFFLINE_LEASE_KEY_ID,
    OFFLINE_LEASE_TTL_SECONDS: value.OFFLINE_LEASE_TTL_HOURS * 3600,
    PLATFORM_ADMIN_ACCESS_KEY: value.PLATFORM_ADMIN_ACCESS_KEY,
    PLATFORM_SESSION_SIGNING_KEY: value.PLATFORM_SESSION_SIGNING_KEY,
    PLATFORM_ADMIN_ACTOR_REF: value.PLATFORM_ADMIN_ACTOR_REF,
    PLATFORM_SESSION_TTL_SECONDS: value.PLATFORM_SESSION_TTL_HOURS * 3600,
    isProduction: value.NODE_ENV === 'production',
    checkoutFiscalizationMode: value.NODE_ENV === 'production' ? 'production' : 'disabled',
  };
}
