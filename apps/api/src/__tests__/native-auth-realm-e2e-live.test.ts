import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@korvi/domain';
import { createPrismaClient, provisionPermissionCatalogue, withTenant } from '@korvi/database';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { PrismaClient } from '@korvi/database';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

/**
 * PostgreSQL-backed realm-separation regression proof.
 *
 * Native credentials may authorize cashier business APIs, but they are not
 * browser sessions and must never enter `/v1/auth/*` cookie-session surfaces.
 * Commercial state and enrollment are established through supported HTTP flows.
 */
const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const ORIGIN = 'http://localhost:3000';
const PLATFORM_ACCESS_KEY = 'native-realm-access-'.padEnd(48, 'a');
const PLATFORM_SIGNING_KEY = 'native-realm-session-'.padEnd(48, 'b');
const BOOTSTRAP_SIGNING_KEY = 'native-realm-bootstrap-'.padEnd(48, 'c');
const OWNER_PASSWORD = 'Native-Realm-Owner-Password-9!';

interface TenantWire {
  readonly id: string;
  readonly slug: string;
}

interface OwnerCapability {
  readonly capability: string;
}

interface OperationsWire {
  readonly branch: { readonly id: string };
  readonly terminal: { readonly id: string };
}

interface EnrollmentWire {
  readonly enrollment: { readonly id: string };
}

interface ChallengeWire {
  readonly challengeId: string;
  readonly signingPayload: string;
}

interface NativeLoginWire {
  readonly token: string;
}

function cookieFrom(response: LightMyRequestResponse): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) throw new Error('expected session cookie');
  return value.split(';', 1)[0] ?? '';
}

function browserHeaders(cookie?: string): Record<string, string> {
  return { origin: ORIGIN, ...(cookie === undefined ? {} : { cookie }) };
}

function nativeHeaders(token: string, cookie?: string): Record<string, string> {
  return {
    origin: ORIGIN,
    authorization: `KorviNative ${token}`,
    ...(cookie === undefined ? {} : { cookie }),
  };
}

function expectUnauthenticated(response: LightMyRequestResponse): void {
  expect(response.statusCode, response.body).toBe(401);
  expect(response.json()).toMatchObject({ error: 'unauthenticated' });
}

describe.skipIf(url === '')('Native/browser realm separation / PostgreSQL 17', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let platformCookie: string;
  let tenantId = '';

  beforeAll(async () => {
    process.env['DATABASE_URL'] = url;
    process.env['BOOTSTRAP_SIGNING_KEY'] = BOOTSTRAP_SIGNING_KEY;
    prisma = createPrismaClient(url);
    await provisionPermissionCatalogue(prisma);

    app = buildServer(
      loadConfig({
        NODE_ENV: 'test',
        LOG_LEVEL: 'fatal',
        APP_ORIGINS: ORIGIN,
        DATABASE_URL: url,
        BOOTSTRAP_SIGNING_KEY,
        PLATFORM_ADMIN_ACCESS_KEY: PLATFORM_ACCESS_KEY,
        PLATFORM_SESSION_SIGNING_KEY: PLATFORM_SIGNING_KEY,
        PLATFORM_ADMIN_ACTOR_REF: 'platform:test/native-realm-live',
        PLATFORM_SESSION_TTL_HOURS: '1',
        SESSION_TTL_HOURS: '1',
      }),
    );
    await app.ready();

    const platformLogin = await app.inject({
      method: 'POST',
      url: '/v1/platform/session',
      headers: browserHeaders(),
      payload: { accessKey: PLATFORM_ACCESS_KEY },
    });
    expect(platformLogin.statusCode).toBe(200);
    platformCookie = cookieFrom(platformLogin);
  }, 90_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (prisma !== undefined) {
      if (tenantId !== '') {
        await withTenant(prisma, tenantId, async (tx) => {
          await tx.tenant.deleteMany({ where: { id: tenantId } });
        });
      }
      await prisma.$disconnect();
    }
  }, 90_000);

  it('keeps valid Native sessions out of browser auth surfaces without weakening business auth', async () => {
    const suffix = newId().replaceAll('-', '').slice(-12);
    const slug = `realm-${suffix}`;
    const ownerEmail = `owner-${suffix}@native-realm.test`;

    const createTenant = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      headers: browserHeaders(platformCookie),
      payload: {
        operationId: newId(),
        slug,
        name: 'Native Realm Proof',
        vatNumber: null,
        vertical: 'retail',
      },
    });
    expect(createTenant.statusCode).toBe(201);
    const tenant = createTenant.json<TenantWire>();
    tenantId = tenant.id;

    const plan = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/plan`,
      headers: browserHeaders(platformCookie),
      payload: {
        operationId: newId(),
        planKey: 'commercial',
        planRevision: 1,
        accountState: 'active',
        entitlements: [
          { key: 'users.max', kind: 'limit', limit: '10' },
          { key: 'pos.enabled', kind: 'flag', enabled: true },
        ],
      },
    });
    expect(plan.statusCode).toBe(200);

    const ownerIssue = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/owner-bootstrap`,
      headers: browserHeaders(platformCookie),
      payload: { operationId: newId(), email: ownerEmail, displayName: 'Realm Owner' },
    });
    expect(ownerIssue.statusCode).toBe(201);
    const capability = ownerIssue.json<OwnerCapability>().capability;

    const ownerAccept = await app.inject({
      method: 'POST',
      url: '/v1/bootstrap/owner',
      headers: browserHeaders(),
      payload: { token: capability, password: OWNER_PASSWORD },
    });
    expect(ownerAccept.statusCode).toBe(204);

    const operational = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/operational-bootstrap`,
      headers: browserHeaders(platformCookie),
      payload: {
        operationId: newId(),
        branch: { code: 'BR-01', nameAr: 'الفرع الرئيسي', nameEn: 'Main Branch' },
        terminal: { code: 'POS-01', label: 'Realm Terminal' },
      },
    });
    expect(operational.statusCode).toBe(201);
    const topology = operational.json<OperationsWire>();

    const activate = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/activate`,
      headers: browserHeaders(platformCookie),
      payload: { operationId: newId() },
    });
    expect(activate.statusCode).toBe(200);

    const browserLogin = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: browserHeaders(),
      payload: { tenantSlug: slug, email: ownerEmail, password: OWNER_PASSWORD },
    });
    expect(browserLogin.statusCode).toBe(200);
    const merchantCookie = cookieFrom(browserLogin);

    const browserMe = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: browserHeaders(merchantCookie),
    });
    expect(browserMe.statusCode).toBe(200);

    const pair = generateKeyPairSync('ed25519');
    const publicSpki = pair.publicKey.export({ format: 'der', type: 'spki' });
    const installationId = newId();
    const enroll = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/device-enrollments`,
      headers: browserHeaders(platformCookie),
      payload: {
        operationId: newId(),
        terminalId: topology.terminal.id,
        installationId,
        platform: 'windows',
        normalizedFingerprintDigest: createHash('sha256')
          .update(`realm:${installationId}`)
          .digest('hex'),
        publicKeySpki: publicSpki.toString('base64'),
        publicKeySha256: createHash('sha256').update(publicSpki).digest('hex'),
        keyAlgorithm: 'ed25519',
        appVersion: '1.0.0-native-realm',
      },
    });
    expect(enroll.statusCode).toBe(201);
    const enrollmentId = enroll.json<EnrollmentWire>().enrollment.id;

    const challengeResponse = await app.inject({
      method: 'POST',
      url: '/v1/native-auth/challenge',
      payload: { tenantId: tenant.id, deviceEnrollmentId: enrollmentId },
    });
    expect(challengeResponse.statusCode).toBe(200);
    const challenge = challengeResponse.json<ChallengeWire>();
    const signature = sign(
      null,
      Buffer.from(challenge.signingPayload, 'utf8'),
      pair.privateKey,
    ).toString('base64url');

    const nativeLogin = await app.inject({
      method: 'POST',
      url: '/v1/native-auth/login',
      payload: {
        tenantId: tenant.id,
        deviceEnrollmentId: enrollmentId,
        challengeId: challenge.challengeId,
        tenantSlug: slug,
        email: ownerEmail,
        password: OWNER_PASSWORD,
        signature,
      },
    });
    expect(nativeLogin.statusCode).toBe(200);
    const nativeToken = nativeLogin.json<NativeLoginWire>().token;

    const nativeMe = await app.inject({
      method: 'GET',
      url: '/v1/native-auth/me',
      headers: nativeHeaders(nativeToken),
    });
    expect(nativeMe.statusCode).toBe(200);

    // Native is valid for the shared cashier business surface.
    const nativeBusiness = await app.inject({
      method: 'GET',
      url: '/v1/terminals',
      headers: nativeHeaders(nativeToken),
    });
    expect(nativeBusiness.statusCode).toBe(200);

    // But it is never a browser session, with or without a valid cookie beside it.
    const nativeIntoBrowser = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: nativeHeaders(nativeToken),
    });
    expectUnauthenticated(nativeIntoBrowser);

    const mixedIntoBrowser = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: nativeHeaders(nativeToken, merchantCookie),
    });
    expectUnauthenticated(mixedIntoBrowser);

    const nativeLogoutAll = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: nativeHeaders(nativeToken, merchantCookie),
    });
    expectUnauthenticated(nativeLogoutAll);

    // Refusing the browser realm did not destroy the Native session or alter
    // normal browser-cookie behavior.
    const nativeStillValid = await app.inject({
      method: 'GET',
      url: '/v1/native-auth/me',
      headers: nativeHeaders(nativeToken),
    });
    expect(nativeStillValid.statusCode).toBe(200);
    const browserStillValid = await app.inject({
      method: 'GET',
      url: '/v1/auth/me',
      headers: browserHeaders(merchantCookie),
    });
    expect(browserStillValid.statusCode).toBe(200);

    const invalidNativeCannotFallBack = await app.inject({
      method: 'GET',
      url: '/v1/terminals',
      headers: nativeHeaders('definitely-invalid', merchantCookie),
    });
    expectUnauthenticated(invalidNativeCannotFallBack);
  }, 120_000);
});
