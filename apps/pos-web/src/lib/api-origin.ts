/**
 * Where the Next server forwards /v1/* to.
 *
 * The browser never speaks to Fastify directly. It calls its own origin, Next
 * rewrites the path to the API, and the session cookie stays a first-party
 * cookie on the host the user actually typed. That is what keeps `__Host-`
 * usable, keeps SameSite=Lax meaningful, and keeps the Origin header on an
 * unsafe request equal to the browser's real origin — which is the exact value
 * Strike 2B checks against APP_ORIGINS (ADR-0014).
 *
 * Pure and separate from next.config.ts so it can be tested. A rewrite
 * destination is baked into the build, and a wrong one is a proxy to somewhere
 * nobody chose.
 */

/** Loopback, so an unconfigured deployment fails to connect rather than reaching a stranger. */
export const DEVELOPMENT_API_ORIGIN = 'http://127.0.0.1:3001';

export class ApiOriginError extends Error {
  public override readonly name = 'ApiOriginError';
}

/**
 * Validate KORVI_API_ORIGIN, or fall back to loopback.
 *
 * An absolute http(s) origin and nothing else: a value carrying a path, a
 * query or credentials is a misconfiguration that would silently rewrite every
 * API call somewhere unintended, so it stops the build instead.
 */
export function resolveApiOrigin(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (value === '') return DEVELOPMENT_API_ORIGIN;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiOriginError(`KORVI_API_ORIGIN is not a URL: "${value}".`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiOriginError(`KORVI_API_ORIGIN must be http or https, got "${url.protocol}".`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new ApiOriginError('KORVI_API_ORIGIN must not carry credentials.');
  }
  if (url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ApiOriginError(
      `KORVI_API_ORIGIN must be a bare origin with no path, got "${value}".`,
    );
  }
  return url.origin;
}
