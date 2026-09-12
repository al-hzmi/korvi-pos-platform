import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const productionEnvironment = {
  NODE_ENV: 'production',
  APP_ORIGINS: 'https://korvi.example',
  BOOTSTRAP_SIGNING_KEY: 'bootstrap-config-test-key-000000000000000000000001',
  METRICS_AUTH_TOKEN: 'metrics-config-test-token-0000000000000000000000002',
};

describe('production secret configuration', () => {
  it('accepts separate canonical production credentials', () => {
    const config = loadConfig(productionEnvironment);

    expect(config.isProduction).toBe(true);
    expect(config.BOOTSTRAP_SIGNING_KEY).toBe(productionEnvironment.BOOTSTRAP_SIGNING_KEY);
    expect(config.METRICS_AUTH_TOKEN).toBe(productionEnvironment.METRICS_AUTH_TOKEN);
  });

  it('refuses credential reuse across bootstrap signing and telemetry', () => {
    const shared = 'shared-config-test-secret-00000000000000000000000001';

    expect(() =>
      loadConfig({
        ...productionEnvironment,
        BOOTSTRAP_SIGNING_KEY: shared,
        METRICS_AUTH_TOKEN: shared,
      }),
    ).toThrow('security domains cannot share a production secret');
  });

  it.each(['BOOTSTRAP_SIGNING_KEY', 'METRICS_AUTH_TOKEN'] as const)(
    'refuses non-canonical whitespace in %s',
    (key) => {
      const secret = ` ${productionEnvironment[key]} `;
      let thrown: Error | undefined;

      try {
        loadConfig({ ...productionEnvironment, [key]: secret });
      } catch (error) {
        thrown = error instanceof Error ? error : new Error('non-Error thrown');
      }

      expect(thrown?.message).toContain('must be a canonical secret');
      expect(thrown?.message).not.toContain(secret);
      expect(thrown?.message).not.toContain(productionEnvironment[key]);
    },
  );

  it('never echoes a reused credential in the validation error', () => {
    const shared = 'shared-config-test-secret-00000000000000000000000002';
    let thrown: Error | undefined;

    try {
      loadConfig({
        ...productionEnvironment,
        BOOTSTRAP_SIGNING_KEY: shared,
        METRICS_AUTH_TOKEN: shared,
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error('non-Error thrown');
    }

    expect(thrown?.message).toContain('security domains cannot share a production secret');
    expect(thrown?.message).not.toContain(shared);
  });

  it('does not impose production-only separation on local development', () => {
    const shared = 'shared-local-config-test-secret-00000000000000000000001';
    const config = loadConfig({
      NODE_ENV: 'development',
      BOOTSTRAP_SIGNING_KEY: shared,
      METRICS_AUTH_TOKEN: shared,
    });

    expect(config.isProduction).toBe(false);
    expect(config.BOOTSTRAP_SIGNING_KEY).toBe(shared);
    expect(config.METRICS_AUTH_TOKEN).toBe(shared);
  });
});
