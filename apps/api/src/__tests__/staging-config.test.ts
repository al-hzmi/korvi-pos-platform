import { describe, expect, it } from 'vitest';
import { loadStagingConfig } from '../staging/config.js';

const environment = {
  NODE_ENV: 'production',
  KORVI_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgresql://localhost/korvi_staging_test',
  BOOTSTRAP_SIGNING_KEY: 'synthetic-staging-config-test-key-only',
  APP_ORIGINS: 'https://korvi-web.example',
  PORT: '10000',
};

describe('isolated staging configuration', () => {
  it('honours the hosting port and keeps production cookie semantics', () => {
    const config = loadStagingConfig(environment);
    expect(config.API_PORT).toBe(10000);
    expect(config.isProduction).toBe(true);
    expect(config.APP_ORIGINS).toEqual(['https://korvi-web.example']);
  });

  it.each([
    'NODE_ENV',
    'KORVI_ENVIRONMENT',
    'DATABASE_URL',
    'BOOTSTRAP_SIGNING_KEY',
    'APP_ORIGINS',
  ])('refuses missing %s before any database connection', (key) => {
    const env: NodeJS.ProcessEnv = { ...environment };
    delete env[key];
    expect(() => loadStagingConfig(env)).toThrow();
  });

  it.each([
    '*',
    'http://korvi-web.example',
    'https://korvi-web.example/',
    'https://korvi-web.example/path',
    'https://korvi-web.example?token=private',
    'https://user:password@korvi-web.example',
    'https://korvi-web.example#fragment',
  ])('refuses the non-canonical origin %s without echoing it', (APP_ORIGINS) => {
    expect(() => loadStagingConfig({ ...environment, APP_ORIGINS })).toThrow(
      'Staging APP_ORIGINS must contain exact HTTPS origins.',
    );
  });

  it('allows explicitly listed HTTPS origins', () => {
    const config = loadStagingConfig({
      ...environment,
      APP_ORIGINS: 'https://one.example, https://two.example',
    });
    expect(config.APP_ORIGINS).toEqual(['https://one.example', 'https://two.example']);
  });

  it.each(['0', '-1', '65536', 'not-a-port'])('refuses unusable port %s', (PORT) => {
    expect(() => loadStagingConfig({ ...environment, PORT })).toThrow();
  });
});
