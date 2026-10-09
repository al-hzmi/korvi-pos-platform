import { resolveApiOrigin } from './src/lib/api-origin';
import type { NextConfig } from 'next';

/**
 * Same-origin topology (ADR-0014).
 *
 * The browser calls /v1/* on its own origin; Next forwards it to Fastify. No
 * CORS is involved anywhere, because nothing ever crosses an origin: the
 * cookie is first-party, and the Origin header Fastify checks is the browser's
 * real one rather than something a proxy invented.
 *
 * Nothing here makes a security decision. Next carries bytes; Fastify decides.
 */
const apiOrigin = resolveApiOrigin(process.env['KORVI_API_ORIGIN']);

const browserSecurityHeaders = [
  {
    key: 'Content-Security-Policy',
    // Deliberately scoped to navigation/embed primitives. Tightening script,
    // style or connect-src without a nonce/hash rollout would risk breaking the
    // POS shell and service worker. These directives close the reviewed framing,
    // object and base-URL gaps without weakening existing same-origin topology.
    value: "base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Korvi may use the same-origin camera for barcode capture. Do not disable it
  // globally while denying unrelated microphone/geolocation capabilities.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()' },
  ...(process.env['NODE_ENV'] === 'production'
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000' }]
    : []),
] as const;

const config: NextConfig = {
  reactStrictMode: true,
  // @korvi/ui ships compiled JS, but transpiling it here keeps source maps
  // pointing at the real TSX during development.
  transpilePackages: ['@korvi/ui'],
  typedRoutes: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [...browserSecurityHeaders],
      },
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${apiOrigin}/v1/:path*` }];
  },
};

export default config;
