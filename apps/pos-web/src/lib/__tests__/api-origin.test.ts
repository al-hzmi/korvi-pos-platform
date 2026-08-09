import { describe, expect, it } from 'vitest';
import { ApiOriginError, DEVELOPMENT_API_ORIGIN, resolveApiOrigin } from '../api-origin';

describe('resolveApiOrigin', () => {
  it('falls back to loopback when nothing is configured', () => {
    // Loopback rather than a guess: an unconfigured deployment fails to
    // connect, which is visible, instead of proxying somewhere unintended.
    expect(resolveApiOrigin(undefined)).toBe(DEVELOPMENT_API_ORIGIN);
    expect(resolveApiOrigin('  ')).toBe(DEVELOPMENT_API_ORIGIN);
  });

  it('accepts a bare origin', () => {
    expect(resolveApiOrigin('https://api.korvi.example')).toBe('https://api.korvi.example');
    expect(resolveApiOrigin('http://127.0.0.1:3001/')).toBe('http://127.0.0.1:3001');
  });

  it.each([
    ['not-a-url'],
    ['ftp://api.korvi.example'],
    ['https://user:secret@api.korvi.example'],
    ['https://api.korvi.example/v1'],
    ['https://api.korvi.example?x=1'],
  ])('refuses %s at build time', (value) => {
    expect(() => resolveApiOrigin(value)).toThrow(ApiOriginError);
  });
});
