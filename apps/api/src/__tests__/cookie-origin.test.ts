import { describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_COOKIE_NAME,
  PRODUCTION_COOKIE_NAME,
  buildClearedCookieHeader,
  buildSessionCookie,
  readCookie,
} from '../auth/cookie.js';
import { checkOrigin, isSafeMethod } from '../auth/origin.js';

describe('the session cookie', () => {
  it('is HttpOnly, Secure, SameSite=Lax, Path=/ and host-only in production', () => {
    const header = buildSessionCookie('kps1.token', { isProduction: true, maxAgeSeconds: 43_200 });
    expect(header).toContain(`${PRODUCTION_COOKIE_NAME}=kps1.token`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=43200');
    // A Domain attribute would send this to every sibling subdomain.
    expect(header).not.toContain('Domain=');
  });

  it('uses the __Host- prefix in production, which the browser enforces', () => {
    expect(PRODUCTION_COOKIE_NAME.startsWith('__Host-')).toBe(true);
    // Development drops the prefix only because it requires HTTPS; nothing
    // else about the cookie changes.
    expect(DEVELOPMENT_COOKIE_NAME.startsWith('__Host-')).toBe(false);
    const dev = buildSessionCookie('t', { isProduction: false, maxAgeSeconds: 60 });
    expect(dev).toContain('HttpOnly');
    expect(dev).toContain('SameSite=Lax');
    expect(dev).not.toContain('Secure');
  });

  it('clears with the same attributes, or the browser keeps the old one', () => {
    const header = buildClearedCookieHeader(true);
    expect(header).toContain(`${PRODUCTION_COOKIE_NAME}=`);
    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
  });

  it('reads one cookie out of a header carrying several', () => {
    const header = `theme=dark; ${DEVELOPMENT_COOKIE_NAME}=kps1.abc; locale=ar`;
    expect(readCookie(header, DEVELOPMENT_COOKIE_NAME)).toBe('kps1.abc');
    expect(readCookie(header, 'missing')).toBeNull();
    expect(readCookie(undefined, DEVELOPMENT_COOKIE_NAME)).toBeNull();
  });

  it('does not match a cookie whose name merely ends with the one asked for', () => {
    expect(readCookie('evil_korvi_session=x', 'korvi_session')).toBeNull();
  });
});

describe('origin checking', () => {
  const allowed = ['https://pos.korvi.sa'];

  it('lets safe methods through without an Origin', () => {
    expect(isSafeMethod('GET')).toBe(true);
    expect(checkOrigin('GET', undefined, allowed).allowed).toBe(true);
  });

  it('accepts an exact origin match on a write', () => {
    expect(checkOrigin('POST', 'https://pos.korvi.sa', allowed).allowed).toBe(true);
  });

  it('refuses a write with no Origin at all', () => {
    // Fail closed: something that is not a browser, or one too old to send it.
    const decision = checkOrigin('POST', undefined, allowed);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('missing-origin');
  });

  it.each([
    'https://pos.korvi.sa.evil.example',
    'https://evil.example',
    'http://pos.korvi.sa',
    'https://pos.korvi.sa:8443',
    'https://POS.korvi.sa',
  ])('refuses %s, because matching is exact and not by suffix', (origin) => {
    expect(checkOrigin('POST', origin, allowed).allowed).toBe(false);
  });

  it('refuses every unsafe method, not just POST', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(checkOrigin(method, 'https://evil.example', allowed).allowed).toBe(false);
    }
  });
});
