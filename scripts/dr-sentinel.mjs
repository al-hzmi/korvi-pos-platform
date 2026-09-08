import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import {
  activateTenant,
  createPrismaClient,
  provisionPermissionCatalogue,
  provisionTenant,
  withTenant,
} from '../packages/database/dist/src/index.js';

const [mode, evidencePath] = process.argv.slice(2);
if (mode !== 'seed' && mode !== 'verify') {
  throw new Error('Usage: node scripts/dr-sentinel.mjs <seed|verify> <evidence-path>');
}
if (evidencePath === undefined || evidencePath.trim() === '') {
  throw new Error('An evidence path is required.');
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined || connectionString.trim() === '') {
  throw new Error('DATABASE_URL is required.');
}

const PROVISIONED_AT = new Date('2026-09-08T00:00:00.000Z');
const ACTIVATED_AT = new Date('2026-09-08T00:01:00.000Z');
const SENTINEL_SLUG = 'korvi-dr-rehearsal';
const SENTINEL_NAME = 'Korvi DR Rehearsal';
const CONTROL_PLANE_ACTOR = 'github-actions-dr-rehearsal';
const PROVISION_OPERATION = 'dr-provision-20260908';
const ACTIVATE_OPERATION = 'dr-activate-20260908';

async function readSentinel(prisma, tenantId) {
  return withTenant(prisma, tenantId, async (tx) => {
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        lifecycleProvenance: true,
        provisioningOperationId: true,
        provisioningRequestHash: true,
        activatedAt: true,
      },
    });
    assert.notEqual(tenant, null, 'DR sentinel tenant is missing under its own RLS context.');

    const settings = await tx.tenantSettings.findFirst({
      where: { tenantId },
      select: { tenantId: true, vertical: true },
    });
    assert.notEqual(settings, null, 'DR sentinel tenant settings are missing.');

    const roles = await tx.role.findMany({
      where: { tenantId },
      orderBy: { key: 'asc' },
      select: {
        id: true,
        key: true,
        nameAr: true,
        nameEn: true,
        maxDiscountBasisPoints: true,
        isSystem: true,
      },
    });

    const rolePermissions = await tx.rolePermission.findMany({
      where: { tenantId },
      orderBy: [{ roleId: 'asc' }, { permissionKey: 'asc' }],
      select: { roleId: true, permissionKey: true },
    });

    const lifecycleReservations = await tx.idempotencyKey.findMany({
      where: { tenantId, scope: 'tenant-lifecycle' },
      orderBy: { operationId: 'asc' },
      select: {
        scope: true,
        operationId: true,
        status: true,
        resultType: true,
        resultId: true,
        requestHash: true,
        completedAt: true,
      },
    });

    const auditEvents = await tx.auditEvent.findMany({
      where: { tenantId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        eventType: true,
        entityType: true,
        entityId: true,
        actorUserId: true,
        branchId: true,
        terminalId: true,
        metadata: true,
        occurredAt: true,
      },
    });

    return {
      tenant,
      settings,
      roles,
      rolePermissions,
      lifecycleReservations,
      auditEvents,
    };
  });
}

const prisma = createPrismaClient(connectionString);
try {
  if (mode === 'seed') {
    const permissionCount = await provisionPermissionCatalogue(prisma);
    assert.ok(permissionCount > 0, 'Permission catalogue must not be empty.');

    const tenant = await provisionTenant(
      prisma,
      {
        operationId: PROVISION_OPERATION,
        slug: SENTINEL_SLUG,
        name: SENTINEL_NAME,
        vatNumber: null,
        vertical: 'retail',
        controlPlaneActorRef: CONTROL_PLANE_ACTOR,
      },
      () => PROVISIONED_AT,
    );
    assert.equal(tenant.created, true, 'Fresh DR source database unexpectedly replayed a tenant.');

    const activation = await activateTenant(
      prisma,
      {
        tenantId: tenant.id,
        operationId: ACTIVATE_OPERATION,
        controlPlaneActorRef: CONTROL_PLANE_ACTOR,
      },
      () => ACTIVATED_AT,
    );
    assert.equal(activation.changed, true, 'Fresh DR sentinel activation did not change state.');
    assert.equal(activation.status, 'active');

    const evidence = {
      permissionCount,
      sentinel: await readSentinel(prisma, tenant.id),
    };
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    console.log(`[ok] DR sentinel created through application authorities: ${tenant.id}`);
  } else {
    const expected = JSON.parse(await readFile(evidencePath, 'utf8'));
    const tenantId = expected?.sentinel?.tenant?.id;
    assert.equal(typeof tenantId, 'string', 'Expected evidence does not contain a tenant id.');

    const permissionCount = await prisma.permission.count();
    const actual = {
      permissionCount,
      sentinel: await readSentinel(prisma, tenantId),
    };
    assert.deepStrictEqual(actual, expected);
    console.log(
      `[ok] restored DR sentinel is byte-semantically identical through application reads: ${tenantId}`,
    );
  }
} finally {
  await prisma.$disconnect();
}
