import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // @korvi/ui ships compiled JS, but transpiling it here keeps source maps
  // pointing at the real TSX during development.
  transpilePackages: ['@korvi/ui'],
  typedRoutes: true,
};

export default config;
