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

const config: NextConfig = {
  reactStrictMode: true,
  // @korvi/ui ships compiled JS, but transpiling it here keeps source maps
  // pointing at the real TSX during development.
  transpilePackages: ['@korvi/ui'],
  typedRoutes: true,
  async rewrites() {
    return [{ source: '/v1/:path*', destination: `${apiOrigin}/v1/:path*` }];
  },
};

export default config;
