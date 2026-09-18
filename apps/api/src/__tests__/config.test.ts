import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';

const productionEnvironment = {
  NODE_ENV: 'production',
  APP_ORIGINS: 'https://korvi.example',
  DATABASE_URL: 'postgresql://korvi_test@localhost:5432/korvi_test',
  BOOTSTRAP_SIGNING_KEY: 'bootstrap-config-test-key-000000000000000000000001',
  METRICS_AUTH_TOKEN: 'metrics-config-test-token-0000000000000000000000002',
  OFFLINE_LEASE_SIGNING_SEED_B64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  OFFLINE_LEASE_KEY_ID: 'config-test-v1',
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

  it.each([
    ['PLATFORM_ADMIN_ACCESS_KEY', 'BOOTSTRAP_SIGNING_KEY'],
    ['PLATFORM_SESSION_SIGNING_KEY', 'METRICS_AUTH_TOKEN'],
    ['PLATFORM_ADMIN_ACCESS_KEY', 'OFFLINE_LEASE_SIGNING_SEED_B64'],
  ] as const)(
    'refuses production secret reuse between %s and %s',
    (leftKey, rightKey) => {
      const shared =
        rightKey === 'OFFLINE_LEASE_SIGNING_SEED_B64'
          ? 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
          : 'cross-domain-config-test-secret-0000000000000000001';

      expect(() =>
        loadConfig({
          ...productionEnvironment,
          PLATFORM_ADMIN_ACCESS_KEY: 'platform-access-config-test-000000000000000001',
          PLATFORM_SESSION_SIGNING_KEY: 'platform-session-config-test-0000000000000001',
          PLATFORM_ADMIN_ACTOR_REF: 'platform:config-test',
          [leftKey]: shared,
          [rightKey]: shared,
        }),
      ).toThrow('security domains cannot share a production secret');
    },
  );

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

  it('refuses to boot production without the authoritative database', () => {
    const env: NodeJS.ProcessEnv = { ...productionEnvironment };
    delete env['DATABASE_URL'];

    expect(() => loadConfig(env)).toThrow(
      'DATABASE_URL: is required in production; refusing to advertise a live API without its authoritative database',
    );
  });

  it('refuses non-canonical database URL whitespace without echoing the URL', () => {
    const databaseUrl = ` ${productionEnvironment.DATABASE_URL} `;
    let thrown: Error | undefined;

    try {
      loadConfig({ ...productionEnvironment, DATABASE_URL: databaseUrl });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error('non-Error thrown');
    }

    expect(thrown?.message).toContain(
      'DATABASE_URL: must be canonical without leading or trailing whitespace',
    );
    expect(thrown?.message).not.toContain(databaseUrl);
    expect(thrown?.message).not.toContain(productionEnvironment.DATABASE_URL);
  });

  it.each([
    ',,,',
    '*',
    'http://korvi.example',
    'https://korvi.example/',
    'https://korvi.example/path',
    'https://korvi.example?token=private',
    'https://user:password@korvi.example',
    'https://korvi.example#fragment',
  ])('refuses unusable production APP_ORIGINS value %s', (APP_ORIGINS) => {
    expect(() => loadConfig({ ...productionEnvironment, APP_ORIGINS })).toThrow();
  });

  it('refuses duplicate production origins', () => {
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        APP_ORIGINS: 'https://one.example, https://one.example',
      }),
    ).toThrow('APP_ORIGINS: must not contain duplicate origins');
  });

  it('accepts multiple exact HTTPS production origins', () => {
    const config = loadConfig({
      ...productionEnvironment,
      APP_ORIGINS: 'https://one.example, https://two.example',
    });

    expect(config.APP_ORIGINS).toEqual(['https://one.example', 'https://two.example']);
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
    expect(config.DATABASE_URL).toBeUndefined();
  });
});
