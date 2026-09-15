import { createHash, generateKeyPairSync } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@korvi/domain';
import { createPrismaClient, provisionPermissionCatalogue, withTenant } from '@korvi/database';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type { PrismaClient } from '@korvi/database';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

/**
 * Gate 13 — installed-cashier device enrollment authority against real PostgreSQL 17.
 *
 * The proof deliberately exercises the supported Platform HTTP surface while the
 * application is connected as the ordinary restricted, non-bypass role. The
 * device private key never crosses the client boundary; only SPKI public material
 * and its digest are enrolled.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const ORIGIN = 'http://localhost:3000';
const PLATFORM_ACCESS_KEY = 'gate13-access-'.padEnd(48, 'a');
const PLATFORM_SIGNING_KEY = 'gate13-session-'.padEnd(48, 'b');
const BOOTSTRAP_SIGNING_KEY = 'gate13-bootstrap-'.padEnd(48, 'c');
const PLATFORM_ACTOR = 'platform:test/gate-13';
const OWNER_PASSWORD = 'Gate13-Owner-Password-9!';

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

interface ProvisionedTenant {
  readonly id: string;
  readonly slug: string;
  readonly terminalId: string;
  readonly merchantCookie: string;
}

interface EnrollmentWire {
  readonly enrollment: {
    readonly id: string;
    readonly tenantId: string;
    readonly terminalId: string;
    readonly installationId: string;
    readonly platform: 'windows' | 'android';
    readonly normalizedFingerprintDigest: string;
    readonly publicKeySha256: string;
    readonly keyAlgorithm: 'ed25519' | 'p256';
    readonly appVersion: string;
    readonly state: 'active' | 'suspended' | 'revoked' | 'replaced';
  };
  readonly replayed: boolean;
}

interface DeviceKey {
  readonly publicSpki: Buffer;
  readonly publicKeySha256: string;
}

function cookieFrom(response: LightMyRequestResponse, name: string): string {
  const raw = response.headers['set-cookie'];
  if (raw === undefined) throw new Error(`expected ${name} session cookie`);
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) throw new Error(`expected ${name} cookie value`);
  return value.split(';', 1)[0] ?? '';
}

function headers(cookie?: string): Record<string, string> {
  return {
    origin: ORIGIN,
    ...(cookie === undefined ? {} : { cookie }),
  };
}

function makeDeviceKey(): DeviceKey {
  const pair = generateKeyPairSync('ed25519');
  const publicSpki = pair.publicKey.export({ format: 'der', type: 'spki' });
  return {
    publicSpki,
    publicKeySha256: createHash('sha256').update(publicSpki).digest('hex'),
  };
}

function devicePayload(input: {
  readonly operationId: string;
  readonly terminalId: string;
  readonly installationId: string;
  readonly fingerprint: string;
  readonly key: DeviceKey;
  readonly appVersion?: string;
}) {
  return {
    operationId: input.operationId,
    terminalId: input.terminalId,
    installationId: input.installationId,
    platform: 'windows' as const,
    normalizedFingerprintDigest: input.fingerprint,
    publicKeySpki: input.key.publicSpki.toString('base64'),
    publicKeySha256: input.key.publicKeySha256,
    keyAlgorithm: 'ed25519' as const,
    appVersion: input.appVersion ?? '1.0.0-gate13',
  };
}

function expectError(response: LightMyRequestResponse, status: number, error: string): void {
  expect(response.statusCode).toBe(status);
  expect(response.json()).toEqual({ error });
}

describe.skipIf(url === '')('Gate 13 device enrollment authority, live', () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;
  let platformCookie: string;
  let previousDatabaseUrl: string | undefined;
  let previousBootstrapKey: string | undefined;
  const tenantIds: string[] = [];

  async function provisionTenant(label: string): Promise<ProvisionedTenant> {
    const suffix = newId().replaceAll('-', '').slice(-12);
    const slug = `gate13-${label}-${suffix}`;
    const ownerEmail = `owner-${label}-${suffix}@gate13.test`;

    const createTenant = await app.inject({
      method: 'POST',
      url: '/v1/platform/tenants',
      headers: headers(platformCookie),
      payload: {
        operationId: newId(),
        slug,
        name: `Gate 13 ${label}`,
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
      headers: headers(platformCookie),
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
      headers: headers(platformCookie),
      payload: { operationId: newId(), email: ownerEmail, displayName: `Gate 13 ${label} Owner` },
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
      headers: headers(platformCookie),
      payload: {
        operationId: newId(),
        branch: { code: 'BR-01', nameAr: 'الفرع الرئيسي', nameEn: 'Main Branch' },
        terminal: { code: 'POS-01', label: `Gate 13 ${label} terminal` },
      },
    });
    expect(operational.statusCode).toBe(201);
    const operations = operational.json<OperationsWire>();

    const activate = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenant.id}/activate`,
      headers: headers(platformCookie),
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

    return {
      id: tenant.id,
      slug,
      terminalId: operations.terminal.id,
      merchantCookie: cookieFrom(login, 'merchant'),
    };
  }

  async function evidenceCounts(tenantId: string): Promise<{ enrollments: number; audits: number }> {
    return withTenant(prisma, tenantId, async (tx) => {
      const rows = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT count(*)::bigint AS "count" FROM "device_enrollments"
      `;
      const audits = await tx.auditEvent.count({
        where: { tenantId, entityType: 'device-enrollment' },
      });
      return { enrollments: Number(rows[0]?.count ?? 0n), audits };
    });
  }

  beforeAll(async () => {
    previousDatabaseUrl = process.env['DATABASE_URL'];
    previousBootstrapKey = process.env['BOOTSTRAP_SIGNING_KEY'];
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
    platformCookie = cookieFrom(platformLogin, 'platform');
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
    if (previousDatabaseUrl === undefined) delete process.env['DATABASE_URL'];
    else process.env['DATABASE_URL'] = previousDatabaseUrl;
    if (previousBootstrapKey === undefined) delete process.env['BOOTSTRAP_SIGNING_KEY'];
    else process.env['BOOTSTRAP_SIGNING_KEY'] = previousBootstrapKey;
  }, 90_000);

  it('proves enrollment, isolation, idempotency, public-key-only persistence and revocation', async () => {
    const tenantA = await provisionTenant('a');
    const tenantB = await provisionTenant('b');
    const keyA = makeDeviceKey();
    const keyB = makeDeviceKey();
    const operationId = newId();
    const installationId = newId();
    const fingerprintA = createHash('sha256').update(`fingerprint-a:${installationId}`).digest('hex');
    const payloadA = devicePayload({
      operationId,
      terminalId: tenantA.terminalId,
      installationId,
      fingerprint: fingerprintA,
      key: keyA,
    });

    expect(await evidenceCounts(tenantA.id)).toEqual({ enrollments: 0, audits: 0 });

    const merchantRefusal = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments`,
      headers: headers(tenantA.merchantCookie),
      payload: payloadA,
    });
    expectError(merchantRefusal, 401, 'platform_unauthenticated');

    const actorInjection = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments`,
      headers: headers(platformCookie),
      payload: { ...payloadA, controlPlaneActorRef: 'platform:attacker' },
    });
    expectError(actorInjection, 400, 'invalid_body');

    const privateKeyInjection = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments`,
      headers: headers(platformCookie),
      payload: { ...payloadA, privateKey: 'must-never-cross-device-boundary' },
    });
    expectError(privateKeyInjection, 400, 'invalid_body');
    expect(await evidenceCounts(tenantA.id)).toEqual({ enrollments: 0, audits: 0 });

    const created = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments`,
      headers: headers(platformCookie),
      payload: payloadA,
    });
    expect(created.statusCode).toBe(201);
    const first = created.json<EnrollmentWire>();
    expect(first.replayed).toBe(false);
    expect(first.enrollment).toMatchObject({
      tenantId: tenantA.id,
      terminalId: tenantA.terminalId,
      installationId,
      publicKeySha256: keyA.publicKeySha256,
      state: 'active',
    });
    expect(created.body).not.toContain('publicKeySpki');
    expect(created.body).not.toContain('privateKey');

    const exactReplay = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments`,
      headers: headers(platformCookie),
      payload: payloadA,
    });
    expect(exactReplay.statusCode).toBe(200);
    expect(exactReplay.json<EnrollmentWire>()).toMatchObject({
      enrollment: { id: first.enrollment.id },
      replayed: true,
    });

    const changedIntent = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments`,
      headers: headers(platformCookie),
      payload: { ...payloadA, appVersion: '1.0.1-changed-intent' },
    });
    expectError(changedIntent, 409, 'idempotency_conflict');

    const sameKeyNewIntent = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments`,
      headers: headers(platformCookie),
      payload: devicePayload({
        operationId: newId(),
        terminalId: tenantA.terminalId,
        installationId: newId(),
        fingerprint: createHash('sha256').update('same-key-new-intent').digest('hex'),
        key: keyA,
      }),
    });
    expectError(sameKeyNewIntent, 409, 'public_key_already_enrolled');

    const terminalBoundPayload = devicePayload({
      operationId: newId(),
      terminalId: tenantA.terminalId,
      installationId: newId(),
      fingerprint: createHash('sha256').update('second-device-fingerprint').digest('hex'),
      key: keyB,
    });
    const terminalBound = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments`,
      headers: headers(platformCookie),
      payload: terminalBoundPayload,
    });
    expectError(terminalBound, 409, 'terminal_already_enrolled');

    const crossTenantTerminal = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantB.id}/device-enrollments`,
      headers: headers(platformCookie),
      payload: devicePayload({
        operationId: newId(),
        terminalId: tenantA.terminalId,
        installationId: newId(),
        fingerprint: createHash('sha256').update('cross-tenant-terminal').digest('hex'),
        key: makeDeviceKey(),
      }),
    });
    expectError(crossTenantTerminal, 404, 'unknown_terminal');

    const crossTenantRead = await withTenant(prisma, tenantB.id, async (tx) =>
      tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "device_enrollments" WHERE "id" = ${first.enrollment.id}::uuid
      `,
    );
    expect(crossTenantRead).toEqual([]);

    const persisted = await withTenant(prisma, tenantA.id, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          publicKeySpki: Uint8Array;
          publicKeySha256: string;
          controlPlaneActorRef: string;
        }[]
      >`
        SELECT "id", "publicKeySpki", "publicKeySha256", "controlPlaneActorRef"
          FROM "device_enrollments"
         WHERE "id" = ${first.enrollment.id}::uuid
      `;
      const columns = await tx.$queryRaw<{ columnName: string }[]>`
        SELECT column_name AS "columnName"
          FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'device_enrollments'
         ORDER BY ordinal_position
      `;
      const audit = await tx.auditEvent.findMany({
        where: {
          tenantId: tenantA.id,
          entityType: 'device-enrollment',
          entityId: first.enrollment.id,
        },
        select: { eventType: true, actorUserId: true, metadata: true },
        orderBy: { occurredAt: 'asc' },
      });
      return { row: rows[0], columns, audit };
    });
    expect(persisted.row?.id).toBe(first.enrollment.id);
    expect(Buffer.from(persisted.row?.publicKeySpki ?? []).equals(keyA.publicSpki)).toBe(true);
    expect(persisted.row?.publicKeySha256).toBe(keyA.publicKeySha256);
    expect(persisted.row?.controlPlaneActorRef).toBe(PLATFORM_ACTOR);
    expect(persisted.columns.some(({ columnName }) => /private.*key|key.*private/i.test(columnName))).toBe(
      false,
    );
    expect(persisted.audit).toHaveLength(1);
    expect(persisted.audit[0]).toMatchObject({
      eventType: 'platform.device-enrolled',
      actorUserId: null,
      metadata: {
        controlPlaneActorRef: PLATFORM_ACTOR,
        operationId,
        terminalId: tenantA.terminalId,
        publicKeySha256: keyA.publicKeySha256,
      },
    });

    expect(await evidenceCounts(tenantA.id)).toEqual({ enrollments: 1, audits: 1 });

    const crossTenantRevoke = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantB.id}/device-enrollments/${first.enrollment.id}/revoke`,
      headers: headers(platformCookie),
      payload: { operationId: newId(), reason: 'cross-tenant attempt' },
    });
    expectError(crossTenantRevoke, 404, 'unknown_enrollment');
    expect(await evidenceCounts(tenantA.id)).toEqual({ enrollments: 1, audits: 1 });

    const revokeOperationId = newId();
    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments/${first.enrollment.id}/revoke`,
      headers: headers(platformCookie),
      payload: { operationId: revokeOperationId, reason: 'Gate 13 revocation proof' },
    });
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json<EnrollmentWire>()).toMatchObject({
      enrollment: { id: first.enrollment.id, state: 'revoked' },
      replayed: false,
    });

    const revokeReplay = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments/${first.enrollment.id}/revoke`,
      headers: headers(platformCookie),
      payload: { operationId: revokeOperationId, reason: 'Gate 13 revocation proof' },
    });
    expect(revokeReplay.statusCode).toBe(200);
    expect(revokeReplay.json<EnrollmentWire>()).toMatchObject({
      enrollment: { id: first.enrollment.id, state: 'revoked' },
      replayed: true,
    });

    const secondRevoke = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments/${first.enrollment.id}/revoke`,
      headers: headers(platformCookie),
      payload: { operationId: newId(), reason: 'different revoke intent' },
    });
    expectError(secondRevoke, 409, 'enrollment_already_revoked');
    expect(await evidenceCounts(tenantA.id)).toEqual({ enrollments: 1, audits: 2 });

    const revocationAudit = await withTenant(prisma, tenantA.id, async (tx) =>
      tx.auditEvent.findMany({
        where: {
          tenantId: tenantA.id,
          entityType: 'device-enrollment',
          entityId: first.enrollment.id,
          eventType: 'platform.device-revoked',
        },
        select: { actorUserId: true, metadata: true },
      }),
    );
    expect(revocationAudit).toHaveLength(1);
    expect(revocationAudit[0]).toMatchObject({
      actorUserId: null,
      metadata: {
        controlPlaneActorRef: PLATFORM_ACTOR,
        operationId: revokeOperationId,
        terminalId: tenantA.terminalId,
        reason: 'Gate 13 revocation proof',
      },
    });

    const reenrolled = await app.inject({
      method: 'POST',
      url: `/v1/platform/tenants/${tenantA.id}/device-enrollments`,
      headers: headers(platformCookie),
      payload: terminalBoundPayload,
    });
    expect(reenrolled.statusCode).toBe(201);
    expect(reenrolled.json<EnrollmentWire>()).toMatchObject({
      enrollment: {
        terminalId: tenantA.terminalId,
        publicKeySha256: keyB.publicKeySha256,
        state: 'active',
      },
      replayed: false,
    });

    expect(await evidenceCounts(tenantA.id)).toEqual({ enrollments: 2, audits: 3 });
  }, 180_000);
});
