import { z } from 'zod';

/**
 * Environment parsing, once, at the edge.
 *
 * Everything downstream receives a typed object rather than reading
 * process.env, so a missing variable fails at boot with a clear message
 * instead of surfacing as `undefined` inside a request three hours later.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type ApiConfig = Readonly<z.infer<typeof schema>>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${detail}`);
  }
  return parsed.data;
}
