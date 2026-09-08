import type { ApiConfig } from '../config.js';

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface SafeErrorLogFields {
  readonly errorType: string;
  readonly errorCode?: string;
  readonly statusCode: number;
}

/**
 * Reduce an unexpected error to metadata that is safe to persist in an
 * operations log.
 *
 * Driver and library Error.message/stack values are not an authority boundary:
 * they may contain a connection string, SQL detail, tenant input or another
 * secret. Production diagnostics therefore identify the class/code/status and
 * correlate through Fastify's request id instead of serialising the Error.
 */
export function safeErrorLogFields(
  error: Error & { readonly code?: unknown },
  statusCode: number,
): SafeErrorLogFields {
  const errorType = SAFE_IDENTIFIER.test(error.name) ? error.name : 'Error';
  const code = error.code;
  const errorCode = typeof code === 'string' && SAFE_IDENTIFIER.test(code) ? code : undefined;

  return errorCode === undefined
    ? { errorType, statusCode }
    : { errorType, errorCode, statusCode };
}

/**
 * Defence in depth around the default request serializers. Fastify/Pino does
 * not currently log arbitrary request headers by default, but configuration or
 * serializers can change. These paths make the authentication boundary explicit
 * before a future logging change can persist bearer/session material.
 */
export function apiLoggerOptions(config: ApiConfig) {
  return {
    level: config.LOG_LEVEL,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'request.headers.authorization',
        'request.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        'res.headers.set-cookie',
        'response.headers.set-cookie',
      ],
      censor: '[REDACTED]',
    },
  } as const;
}
