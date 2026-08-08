/**
 * The session cookie.
 *
 * HttpOnly so a cross-site script cannot read it — the single most valuable
 * attribute here, because a POS runs on machines where somebody eventually
 * installs a browser extension.
 *
 * SameSite=Lax so a form on another site cannot POST a checkout with the
 * cashier's credentials attached, while an ordinary top-level navigation back
 * into the app still arrives authenticated. Strict would log the user out every
 * time they follow a link from their email.
 *
 * No Domain attribute, so the cookie stays on the exact host that set it and is
 * never sent to a sibling subdomain.
 *
 * `__Host-` in production. The prefix is enforced by the browser: it refuses to
 * store the cookie unless it is Secure, has Path=/ and carries no Domain — so
 * the guarantee survives a future edit to this file. It requires HTTPS, which
 * is why development uses the unprefixed name and nothing else changes.
 */

export const PRODUCTION_COOKIE_NAME = '__Host-korvi_session';
export const DEVELOPMENT_COOKIE_NAME = 'korvi_session';

export function sessionCookieName(isProduction: boolean): string {
  return isProduction ? PRODUCTION_COOKIE_NAME : DEVELOPMENT_COOKIE_NAME;
}

export interface CookieOptions {
  readonly isProduction: boolean;
  readonly maxAgeSeconds: number;
}

export function buildSessionCookie(token: string, options: CookieOptions): string {
  const attributes = [
    `${sessionCookieName(options.isProduction)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${String(options.maxAgeSeconds)}`,
  ];
  // Secure is unconditional in production. In development it is omitted only
  // because http://localhost would otherwise drop the cookie silently, which
  // reads as "login is broken" rather than "your cookie policy is strict".
  if (options.isProduction) attributes.push('Secure');
  return attributes.join('; ');
}

/** Same attributes, empty value, immediate expiry — or the browser keeps it. */
export function buildClearedCookieHeader(isProduction: boolean): string {
  const attributes = [
    `${sessionCookieName(isProduction)}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isProduction) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * Read one cookie out of a Cookie header.
 *
 * Hand-rolled rather than a dependency: the header is a semicolon-separated
 * list and the parsing is six lines, while a parser in the dependency tree is
 * a permanent supply-chain surface on the authentication path (ADR-0009).
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return null;
}
