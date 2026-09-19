import { Buffer } from 'node:buffer';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@korvi/domain';
import { createPrismaClient, provisionPermissionCatalogue, withTenant } from '@korvi/database';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { PrismaClient } from '@korvi/database';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

/**
 * Permanent Native Auth release gate against real PostgreSQL.
 *
 * Commercial state is created only through supported HTTP product flows. Direct
 * SQL is reserved for security observation/fault injection that the public
 * product deliberately cannot express: expiring a challenge and inspecting RLS.
 */
const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const ORIGIN = 'http://localhost:3000';
const PLATFORM_ACCESS_KEY = 'native-gate-access-'.padEnd(48, 'a');
const PLATFORM_SIGNING_KEY = 'native-gate-session-'.padEnd(48, 'b');
const BOOTSTRAP_SIGNING_KEY = 'native-gate-bootstrap-'.padEnd(48, 'c');
const PLATFORM_ACTOR = 'platform:test/native-auth-live';
const OWNER_PASSWORD = 'Native-Gate-Owner-Password-9!';
const OFFLINE_LEASE_SEED = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OFFLINE_LEASE_KEY_ID = 'native-gate-v1';

interface TenantWire {
  readonly id: string;
  readonly slug: string;
}

interface OwnerCapability {
  readonly capability: string;
}

interface OperationsWire {
  readonly branch: { readonly id: string };
  readonly terminal: { readonly id: string; readonly branchId: string };
}

interface BranchWire {
  readonly id: string;
}

interface TerminalWire {
  readonly id: string;
  readonly branchId: string;
}

interface EnrollmentWire {
  readonly enrollment: {
    readonly id: string;
    readonly tenantId: string;
    readonly terminalId: string;
    readonly state: 'active' | 'suspended' | 'revoked' | 'replaced';
  };
  readonly replayed: boolean;
}

interface ChallengeWire {
  readonly challengeId: string;
  readonly tenantId: string;
  readonly deviceEnrollmentId: string;
  readonly terminalId: string;
  readonly branchId: string;
  readonly expiresAt: string;
  readonly signingPayload: string;
}

interface NativeLoginWire {
  readonly token: string;
  readonly expiresAt: string;
  readonly binding: {
    readonly deviceEnrollmentId: string;
    readonly terminalId: string;
    readonly branchId: string;
    readonly devicePublicKeySha256: string;
  };
}

interface DeviceKey {
  readonly publicSpki: Buffer;
  readonly publicKeySha256: string;
  readonly privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'];
  readonly privatePkcs8: Buffer;
}

interface MerchantFixture {
  readonly id: string;
  readonly slug: string;
  readonly ownerEmail: string;
  readonly merchantCookie: string;
  readonly branchA: string;
  readonly terminalA: string;
  readonly branchB: string;
  readonly terminalB: string;
  readonly terminalC: string;
}

function cookieFrom(response: LightMyRequestResponse): string {
  const raw = response.headers['set-cookie'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) throw new Error('expected session cookie');
  return value.split(';', 1)[0] ?? '';
}

function headers(input: { cookie?: string; authorization?: string } = {}): Record<string, string> {
  return {
    origin: ORIGIN,
    ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
    ...(input.authorization === undefined ? {} : { authorization: input.authorization }),
  };
}

function makeDeviceKey(): DeviceKey {
  const pair = generateKeyPairSync('ed25519');
  const publicSpki = pair.publicKey.export({ format: 'der', type: 'spki' });
  const privatePkcs8 = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  return {
    publicSpki,
    publicKeySha256: createHash('sha256').update(publicSpki).digest('hex'),
    privateKey: pair.privateKey,
    privatePkcs8,
  };
}

function signature(key: DeviceKey, signingPayload: string): string {
  return sign(null, Buffer.from(signingPayload, 'utf8'), key.privateKey).toString('base64url');
}

function expectError(response: LightMyRequestResponse, status: number, error: string): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toMatchObject({ error });
}

describe.skipIf(url === '')('Native Auth / PostgreSQL 17 release gate', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let platformCookie: string;
  const tenantIds: string[] = [];

  async function provisionMerchant(
    label: string,
    extendedTopology: boolean,
  ): Promise<MerchantFixture> {
    const suffix = newId().replaceAll('-', '').slice(-12);
    const slug = `native-${label}-${suffix}`;
    const ownerEmail = `owner-${label}-${suffix}@native-gate.test`;

    const createTenant = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      headers: headers({ cookie: platformCookie }),
      payload: {
        operationId: newId(),
        slug,
        name: `Native Gate ${label}`,
        vatNumber: null,
        vertical: 'retail',
      },
    });
    expect(createTenant.statusCode).toBe(201);
    const tenant = createTenant.json<TenantWire>();
    tenantIds.push(tenant.id);

    const plan = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/plan`,
      headers: headers({ cookie: platformCookie }),
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
      headers: headers({ cookie: platformCookie }),
      payload: { operationId: newId(), email: ownerEmail, displayName: `Native ${label} Owner` },
    });
    expect(ownerIssue.statusCode).toBe(201);
    const capability = ownerIssue.json<OwnerCapability>().capability;

    const ownerAccept = await app.inject({
      method: 'POST',
      url: '/v1/bootstrap/owner',
      headers: headers(),
      payload: { token: capability, password: OWNER_PASSWORD },
    });
    expect(ownerAccept.statusCode).toBe(204);

    const operational = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/operational-bootstrap`,
      headers: headers({ cookie: platformCookie }),
      payload: {
        operationId: newId(),
        branch: { code: 'BR-A', nameAr: 'الفرع أ', nameEn: 'Branch A' },
        terminal: { code: 'POS-A', label: `Native ${label} Terminal A` },
      },
    });
    expect(operational.statusCode).toBe(201);
    const operations = operational.json<OperationsWire>();

    const activate = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/activate`,
      headers: headers({ cookie: platformCookie }),
      payload: { operationId: newId() },
    });
    expect(activate.statusCode).toBe(200);

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: headers(),
      payload: { tenantSlug: slug, email: ownerEmail, password: OWNER_PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    const merchantCookie = cookieFrom(login);

    let branchB = operations.branch.id;
    let terminalB = operations.terminal.id;
    let terminalC = operations.terminal.id;

    if (extendedTopology) {
      const sameBranchTerminal = await app.inject({
        method: 'POST',
        url: '/v1/admin/terminals',
        headers: headers({ cookie: merchantCookie }),
        payload: { branchId: operations.branch.id, code: 'POS-B', label: 'Terminal B' },
      });
      expect(sameBranchTerminal.statusCode).toBe(201);
      terminalB = sameBranchTerminal.json<TerminalWire>().id;

      const secondBranch = await app.inject({
        method: 'POST',
        url: '/v1/admin/branches',
        headers: headers({ cookie: merchantCookie }),
        payload: { code: 'BR-B', nameAr: 'الفرع ب', nameEn: 'Branch B' },
      });
      expect(secondBranch.statusCode).toBe(201);
      branchB = secondBranch.json<BranchWire>().id;

      const crossBranchTerminal = await app.inject({
        method: 'POST',
        url: '/v1/admin/terminals',
        headers: headers({ cookie: merchantCookie }),
        payload: { branchId: branchB, code: 'POS-C', label: 'Terminal C' },
      });
      expect(crossBranchTerminal.statusCode).toBe(201);
      terminalC = crossBranchTerminal.json<TerminalWire>().id;
    }

    return {
      id: tenant.id,
      slug,
      ownerEmail,
      merchantCookie,
      branchA: operations.branch.id,
      terminalA: operations.terminal.id,
      branchB,
      terminalB,
      terminalC,
    };
  }

  async function enrollDevice(tenantId: string, terminalId: string, key: DeviceKey, label: string) {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantId}/device-enrollments`,
      headers: headers({ cookie: platformCookie }),
      payload: {
        operationId: newId(),
        terminalId,
        installationId: newId(),
        platform: 'windows',
        normalizedFingerprintDigest: createHash('sha256')
          .update(`fingerprint:${label}`)
          .digest('hex'),
        publicKeySpki: key.publicSpki.toString('base64'),
        publicKeySha256: key.publicKeySha256,
        keyAlgorithm: 'ed25519',
        appVersion: '1.0.0-native-gate',
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<EnrollmentWire>().enrollment;
  }

  async function issueChallenge(tenantId: string, enrollmentId: string): Promise<ChallengeWire> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/native-auth/challenge',
      headers: headers(),
      payload: { tenantId, deviceEnrollmentId: enrollmentId },
    });
    expect(response.statusCode).toBe(200);
    return response.json<ChallengeWire>();
  }

  async function nativeLogin(input: {
    tenant: MerchantFixture;
    enrollmentId: string;
    challenge: ChallengeWire;
    key: DeviceKey;
    password?: string;
    signingPayload?: string;
    deviceEnrollmentId?: string;
  }): Promise<LightMyRequestResponse> {
    const signingPayload = input.signingPayload ?? input.challenge.signingPayload;
    return app.inject({
      method: 'POST',
      url: '/v1/native-auth/login',
      headers: headers(),
      payload: {
        tenantId: input.tenant.id,
        deviceEnrollmentId: input.deviceEnrollmentId ?? input.enrollmentId,
        challengeId: input.challenge.challengeId,
        tenantSlug: input.tenant.slug,
        email: input.tenant.ownerEmail,
        password: input.password ?? OWNER_PASSWORD,
        signature: signature(input.key, signingPayload),
      },
    });
  }

  async function nativeSessionCount(tenantId: string): Promise<number> {
    return withTenant(prisma, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS "count" FROM "native_sessions"`;
      return Number(rows[0]?.count ?? 0n);
    });
  }

  async function nativeChallengeCount(tenantId: string, challengeId: string): Promise<number> {
    return withTenant(prisma, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS "count"
          FROM "native_auth_challenges"
         WHERE "id" = ${challengeId}::uuid`;
      return Number(rows[0]?.count ?? 0n);
    });
  }

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
        PLATFORM_ADMIN_ACTOR_REF: PLATFORM_ACTOR,
        PLATFORM_SESSION_TTL_HOURS: '1',
        SESSION_TTL_HOURS: '1',
        OFFLINE_LEASE_SIGNING_SEED_B64: OFFLINE_LEASE_SEED,
        OFFLINE_LEASE_KEY_ID,
        OFFLINE_LEASE_TTL_HOURS: '72',
      }),
    );
    await app.ready();

    const platformLogin = await app.inject({
      method: 'POST',
      url: '/v1/platform/session',
      headers: headers(),
      payload: { accessKey: PLATFORM_ACCESS_KEY },
    });
    expect(platformLogin.statusCode).toBe(200);
    platformCookie = cookieFrom(platformLogin);
  }, 90_000);

  afterAll(async () => {
    if (app !== undefined) await app.close();
    if (prisma !== undefined) {
      for (const tenantId of tenantIds.reverse()) {
        await withTenant(prisma, tenantId, async (tx) => {
          await tx.tenant.deleteMany({ where: { id: tenantId } });
        });
      }
      await prisma.$disconnect();
    }
  }, 90_000);

  it('proves Native device challenge, realm, fencing, RLS and failure atomicity end to end', async () => {
    const tenantA = await provisionMerchant('a', true);
    const tenantB = await provisionMerchant('b', false);
    const keyA = makeDeviceKey();
    const keyC = makeDeviceKey();
    const keyB = makeDeviceKey();
    const enrollmentA = await enrollDevice(
      tenantA.id,
      tenantA.terminalA,
      keyA,
      'tenant-a-terminal-a',
    );
    const enrollmentC = await enrollDevice(
      tenantA.id,
      tenantA.terminalC,
      keyC,
      'tenant-a-terminal-c',
    );
    const enrollmentB = await enrollDevice(
      tenantB.id,
      tenantB.terminalA,
      keyB,
      'tenant-b-terminal-a',
    );

    const db = new pg.Client({ connectionString: url });
    await db.connect();
    const role = await db.query<{
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(`SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`);
    expect(role.rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolinherit: false,
      rolreplication: false,
      rolbypassrls: false,
    });

    const rls = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN ('device_enrollments', 'native_auth_challenges', 'native_sessions')
        ORDER BY relname`,
    );
    expect(rls.rows).toEqual([
      { relname: 'device_enrollments', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'native_auth_challenges', relrowsecurity: true, relforcerowsecurity: true },
      { relname: 'native_sessions', relrowsecurity: true, relforcerowsecurity: true },
    ]);
    await db.end();

    const challenge = await issueChallenge(tenantA.id, enrollmentA.id);
    expect(challenge).toMatchObject({
      tenantId: tenantA.id,
      deviceEnrollmentId: enrollmentA.id,
      terminalId: tenantA.terminalA,
      branchId: tenantA.branchA,
    });
    expect(challenge.signingPayload.split('\n')).toEqual([
      'korvi.native-auth.v1',
      `challenge=${challenge.challengeId}`,
      `tenant=${tenantA.id}`,
      `enrollment=${enrollmentA.id}`,
      `branch=${tenantA.branchA}`,
      `terminal=${tenantA.terminalA}`,
      expect.stringMatching(/^nonce=[A-Za-z0-9_-]+$/),
      `expires=${challenge.expiresAt}`,
    ]);

    const expired = await issueChallenge(tenantA.id, enrollmentA.id);
    await withTenant(prisma, tenantA.id, async (tx) => {
      await tx.$executeRaw`
        UPDATE "native_auth_challenges"
           SET "expiresAt" = "issuedAt" + interval '1 millisecond'
         WHERE "id" = ${expired.challengeId}::uuid`;
    });
    const expiredAttempt = await nativeLogin({
      tenant: tenantA,
      enrollmentId: enrollmentA.id,
      challenge: expired,
      key: keyA,
    });
    expectError(expiredAttempt, 401, 'native_unauthenticated');
    const expiredState = await withTenant(
      prisma,
      tenantA.id,
      async (tx) =>
        tx.$queryRaw<{ consumedAt: Date | null }[]>`
        SELECT "consumedAt" FROM "native_auth_challenges" WHERE "id" = ${expired.challengeId}::uuid`,
    );
    expect(expiredState[0]?.consumedAt).toBeNull();
    expect(await nativeSessionCount(tenantA.id)).toBe(0);

    const wrongSignatureChallenge = await issueChallenge(tenantA.id, enrollmentA.id);
    expect(await nativeChallengeCount(tenantA.id, expired.challengeId)).toBe(0);
    const wrongSignature = await nativeLogin({
      tenant: tenantA,
      enrollmentId: enrollmentA.id,
      challenge: wrongSignatureChallenge,
      key: keyB,
    });
    expectError(wrongSignature, 401, 'native_unauthenticated');
    expect(await nativeSessionCount(tenantA.id)).toBe(0);

    const modifiedChallenge = await issueChallenge(tenantA.id, enrollmentA.id);
    expect(await nativeChallengeCount(tenantA.id, wrongSignatureChallenge.challengeId)).toBe(0);
    const modifiedPayload = await nativeLogin({
      tenant: tenantA,
      enrollmentId: enrollmentA.id,
      challenge: modifiedChallenge,
      key: keyA,
      signingPayload: `${modifiedChallenge.signingPayload}\nmodified=true`,
    });
    expectError(modifiedPayload, 401, 'native_unauthenticated');
    expect(await nativeSessionCount(tenantA.id)).toBe(0);

    const wrongDeviceChallenge = await issueChallenge(tenantA.id, enrollmentA.id);
    const wrongDevice = await nativeLogin({
      tenant: tenantA,
      enrollmentId: enrollmentA.id,
      challenge: wrongDeviceChallenge,
      key: keyA,
      deviceEnrollmentId: enrollmentC.id,
    });
    expectError(wrongDevice, 401, 'native_unauthenticated');
    expect(await nativeSessionCount(tenantA.id)).toBe(0);

    const crossTenantChallenge = await app.inject({
      method: 'POST',
      url: '/v1/native-auth/challenge',
      headers: headers(),
      payload: { tenantId: tenantA.id, deviceEnrollmentId: enrollmentB.id },
    });
    expectError(crossTenantChallenge, 403, 'native_device_refused');

    const badPasswordChallenge = await issueChallenge(tenantA.id, enrollmentA.id);
    const badPassword = await nativeLogin({
      tenant: tenantA,
      enrollmentId: enrollmentA.id,
      challenge: badPasswordChallenge,
      key: keyA,
      password: 'wrong-password',
    });
    expectError(badPassword, 401, 'native_unauthenticated');
    expect(await nativeSessionCount(tenantA.id)).toBe(0);

    const failureAudit = await withTenant(prisma, tenantA.id, async (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: tenantA.id, eventType: 'auth.native.login.failure' },
        select: { actorUserId: true, metadata: true },
      }),
    );
    expect(failureAudit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ reason: 'bad-password' }),
        }),
      ]),
    );

    const goodChallenge = await issueChallenge(tenantA.id, enrollmentA.id);
    const success = await nativeLogin({
      tenant: tenantA,
      enrollmentId: enrollmentA.id,
      challenge: goodChallenge,
      key: keyA,
    });
    expect(success.statusCode).toBe(200);
    const native = success.json<NativeLoginWire>();
    expect(native.binding).toMatchObject({
      deviceEnrollmentId: enrollmentA.id,
      terminalId: tenantA.terminalA,
      branchId: tenantA.branchA,
      devicePublicKeySha256: keyA.publicKeySha256,
    });
    expect(native.token).toMatch(/^kns1\./);
    expect(success.headers['set-cookie']).toBeUndefined();
    expect(await nativeSessionCount(tenantA.id)).toBe(1);

    const replay = await nativeLogin({
      tenant: tenantA,
      enrollmentId: enrollmentA.id,
      challenge: goodChallenge,
      key: keyA,
    });
    expectError(replay, 401, 'native_unauthenticated');
    expect(await nativeSessionCount(tenantA.id)).toBe(1);

    const nativeMe = await app.inject({
      method: 'GET',
      url: '/v1/native-auth/me',
      headers: headers({ authorization: `KorviNative ${native.token}` }),
    });
    expect(nativeMe.statusCode).toBe(200);
    expect(nativeMe.headers['set-cookie']).toBeUndefined();

    const browserCannotEnterNative = await app.inject({
      method: 'GET',
      url: '/v1/native-auth/me',
      headers: headers({ cookie: tenantA.merchantCookie }),
    });
    expectError(browserCannotEnterNative, 401, 'native_unauthenticated');

    const invalidNativeCannotFallBack = await app.inject({
      method: 'GET',
      url: '/v1/terminals',
      headers: headers({
        cookie: tenantA.merchantCookie,
        authorization: 'KorviNative definitely-invalid',
      }),
    });
    expectError(invalidNativeCannotFallBack, 401, 'unauthenticated');

    const browserTerminalB = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${tenantA.terminalB}`,
      headers: headers({ cookie: tenantA.merchantCookie }),
    });
    expect(browserTerminalB.statusCode).toBe(200);

    const nativeHeader = headers({ authorization: `KorviNative ${native.token}` });
    const leaseResponse = await app.inject({
      method: 'POST',
      url: '/v1/native-auth/offline-lease',
      headers: nativeHeader,
    });
    expect(leaseResponse.statusCode).toBe(200);
    const leaseWire = leaseResponse.json<{ lease: string; claims: Record<string, unknown> }>();
    const parts = leaseWire.lease.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('kol1');
    const payload = parts[1] ?? '';
    const signatureBytes = Buffer.from(parts[2] ?? '', 'base64url');
    const seed = Buffer.from(OFFLINE_LEASE_SEED, 'base64url');
    const leasePrivate = createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8',
    });
    expect(
      verify(
        null,
        Buffer.from(`kol1.${payload}`, 'utf8'),
        createPublicKey(leasePrivate),
        signatureBytes,
      ),
    ).toBe(true);
    const leaseClaims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    expect(leaseClaims).toMatchObject({
      version: 1,
      issuer: 'korvi-platform',
      keyId: OFFLINE_LEASE_KEY_ID,
      tenantId: tenantA.id,
      branchId: tenantA.branchA,
      terminalId: tenantA.terminalA,
      deviceEnrollmentId: enrollmentA.id,
      devicePublicKeySha256: keyA.publicKeySha256,
      planKey: 'commercial',
      planRevision: 1,
      leaseRevision: 1,
    });
    expect(
      Date.parse(String(leaseClaims['expiresAt'])) - Date.parse(String(leaseClaims['issuedAt'])),
    ).toBe(72 * 60 * 60 * 1000);
    expect(Array.isArray(leaseClaims['capabilities'])).toBe(true);
    expect(JSON.stringify(leaseClaims)).toContain('pos.enabled');

    const browserLease = await app.inject({
      method: 'POST',
      url: '/v1/native-auth/offline-lease',
      headers: headers({ cookie: tenantA.merchantCookie }),
    });
    expectError(browserLease, 401, 'native_unauthenticated');

    for (const terminalId of [tenantA.terminalB, tenantA.terminalC, tenantB.terminalA]) {
      const refused = await app.inject({
        method: 'GET',
        url: `/v1/shifts/current?terminalId=${terminalId}`,
        headers: nativeHeader,
      });
      expectError(refused, 404, 'unknown_terminal');
    }

    const beforeSubstitution = await withTenant(prisma, tenantA.id, async (tx) =>
      tx.shift.count({ where: { tenantId: tenantA.id, terminalId: tenantA.terminalB } }),
    );
    const substitutionWrite = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: nativeHeader,
      payload: { terminalId: tenantA.terminalB, openingFloatMinor: '0' },
    });
    expectError(substitutionWrite, 404, 'unknown_terminal');
    const afterSubstitution = await withTenant(prisma, tenantA.id, async (tx) =>
      tx.shift.count({ where: { tenantId: tenantA.id, terminalId: tenantA.terminalB } }),
    );
    expect(afterSubstitution).toBe(beforeSubstitution);

    const ownTerminalRead = await app.inject({
      method: 'GET',
      url: `/v1/shifts/current?terminalId=${tenantA.terminalA}`,
      headers: nativeHeader,
    });
    expect(ownTerminalRead.statusCode).toBe(200);

    const ownTerminalWrite = await app.inject({
      method: 'POST',
      url: '/v1/shifts/open',
      headers: nativeHeader,
      payload: { terminalId: tenantA.terminalA, openingFloatMinor: '0' },
    });
    expect(ownTerminalWrite.statusCode).toBe(201);

    const successAudit = await withTenant(prisma, tenantA.id, async (tx) =>
      tx.auditEvent.findMany({
        where: { tenantId: tenantA.id, eventType: 'auth.native.login.success' },
        select: { actorUserId: true, entityId: true, metadata: true },
      }),
    );
    expect(successAudit).toHaveLength(1);
    expect(successAudit[0]).toMatchObject({
      entityId: expect.any(String),
      actorUserId: expect.any(String),
      metadata: {
        deviceEnrollmentId: enrollmentA.id,
        terminalId: tenantA.terminalA,
        branchId: tenantA.branchA,
      },
    });

    const rlsA = await withTenant(prisma, tenantA.id, async (tx) => {
      const challenges = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS "count" FROM "native_auth_challenges"`;
      const sessions = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS "count" FROM "native_sessions"`;
      return {
        challenges: Number(challenges[0]?.count ?? 0n),
        sessions: Number(sessions[0]?.count ?? 0n),
      };
    });
    const rlsB = await withTenant(prisma, tenantB.id, async (tx) => {
      const challenges = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS "count" FROM "native_auth_challenges"`;
      const sessions = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS "count" FROM "native_sessions"`;
      return {
        challenges: Number(challenges[0]?.count ?? 0n),
        sessions: Number(sessions[0]?.count ?? 0n),
      };
    });
    expect(rlsA.challenges).toBeGreaterThan(0);
    expect(rlsA.sessions).toBe(1);
    expect(rlsB).toEqual({ challenges: 0, sessions: 0 });

    const nativeColumns = await withTenant(
      prisma,
      tenantA.id,
      async (tx) =>
        tx.$queryRaw<{ table_name: string; column_name: string }[]>`
        SELECT table_name, column_name
          FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('device_enrollments', 'native_auth_challenges', 'native_sessions')
           AND (lower(column_name) LIKE '%private%' OR lower(column_name) LIKE '%secret%')`,
    );
    expect(nativeColumns).toEqual([]);
    const persistedKeyMaterial = await withTenant(
      prisma,
      tenantA.id,
      async (tx) =>
        tx.$queryRaw<{ publicSpki: string }[]>`
        SELECT encode("publicKeySpki", 'base64') AS "publicSpki"
          FROM "device_enrollments"
         WHERE "id" = ${enrollmentA.id}::uuid`,
    );
    const privateBase64 = keyA.privatePkcs8.toString('base64');
    expect(JSON.stringify(persistedKeyMaterial)).not.toContain(privateBase64);

    const compositeIndexes = await withTenant(
      prisma,
      tenantA.id,
      async (tx) =>
        tx.$queryRaw<{ indisunique: boolean; columns: string[] }[]>`
        SELECT
          i.indisunique,
          array_agg(a.attname ORDER BY key_columns.ordinality)::text[] AS "columns"
        FROM pg_index i
        JOIN pg_class table_relation ON table_relation.oid = i.indrelid
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
          ON TRUE
        JOIN pg_attribute a
          ON a.attrelid = table_relation.oid AND a.attnum = key_columns.attnum
        WHERE table_relation.relname = 'device_enrollments'
        GROUP BY i.indexrelid, i.indisunique`,
    );
    expect(
      compositeIndexes.some(
        (index) =>
          index.indisunique &&
          index.columns.length === 2 &&
          index.columns[0] === 'tenantId' &&
          index.columns[1] === 'id',
      ),
    ).toBe(true);

    const secondChallenge = await issueChallenge(tenantA.id, enrollmentA.id);
    const secondLogin = await nativeLogin({
      tenant: tenantA,
      enrollmentId: enrollmentA.id,
      challenge: secondChallenge,
      key: keyA,
    });
    expect(secondLogin.statusCode).toBe(200);
    const secondNative = secondLogin.json<NativeLoginWire>();

    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments/${enrollmentA.id}/revoke`,
      headers: headers({ cookie: platformCookie }),
      payload: { operationId: newId(), reason: 'Native Auth live revocation proof' },
    });
    expect(revoke.statusCode).toBe(200);

    const revokedChallenge = await app.inject({
      method: 'POST',
      url: '/v1/native-auth/challenge',
      headers: headers(),
      payload: { tenantId: tenantA.id, deviceEnrollmentId: enrollmentA.id },
    });
    expectError(revokedChallenge, 403, 'native_device_refused');

    const revokedSession = await app.inject({
      method: 'GET',
      url: '/v1/native-auth/me',
      headers: headers({ authorization: `KorviNative ${secondNative.token}` }),
    });
    expectError(revokedSession, 401, 'native_unauthenticated');

    const sessionCountAfterRevoke = await nativeSessionCount(tenantA.id);
    expect(sessionCountAfterRevoke).toBe(2);

    const logoutChallenge = await issueChallenge(tenantA.id, enrollmentC.id);
    const branchMismatch = await nativeLogin({
      tenant: tenantA,
      enrollmentId: enrollmentC.id,
      challenge: logoutChallenge,
      key: keyC,
    });
    expectError(branchMismatch, 401, 'native_unauthenticated');
    expect(await nativeSessionCount(tenantA.id)).toBe(sessionCountAfterRevoke);
  }, 180_000);
});
