import { createAuthRepository, createPrismaClient, withTenant } from '@korvi/database';
import { newId, normalizeEmail } from '@korvi/domain';
import { buildServer } from './server.js';
import { loadStagingConfig } from './staging/config.js';
import { verifyStagingDatabase } from './staging/preflight.js';
import type { PrismaClient } from '@korvi/database';

/**
 * Temporary staging-only operator repair for a bootstrapped Owner whose
 * membership has no default branch.
 *
 * The repair is deliberately narrow: it only runs when explicitly enabled,
 * only against an active tenant, only for an active system Owner, and only when
 * there is exactly one active branch to choose. If the merchant has zero or
 * multiple active branches, startup refuses rather than guessing authority.
 *
 * The audit actor is null because this is an operator repair, not a merchant
 * action. The hook is removed immediately after the one repair deployment.
 */
async function repairStagingDefaultBranchIfRequested(prisma: PrismaClient): Promise<void> {
  if (process.env['KORVI_STAGING_BRANCH_RECOVERY'] !== '1') return;

  const slug = process.env['KORVI_STAGING_BRANCH_RECOVERY_TENANT']?.trim() ?? '';
  const email = normalizeEmail(process.env['KORVI_STAGING_BRANCH_RECOVERY_EMAIL'] ?? '');
  if (slug === '' || email === '') {
    throw new Error('Staging branch recovery configuration is incomplete.');
  }

  const tenant = await createAuthRepository(prisma).resolveTenantForLogin(slug);
  if (tenant === null || tenant.status !== 'active') {
    throw new Error('Staging branch recovery tenant is unavailable.');
  }

  await withTenant(prisma, tenant.id, async (tx) => {
    const user = await tx.user.findFirst({
      where: { tenantId: tenant.id, email },
      select: { id: true, isActive: true },
    });
    if (user === null || !user.isActive) {
      throw new Error('Staging branch recovery owner is unavailable.');
    }

    const ownerGrant = await tx.userRole.findFirst({
      where: {
        tenantId: tenant.id,
        userId: user.id,
        role: { key: 'owner', isSystem: true },
      },
      select: { id: true },
    });
    if (ownerGrant === null) {
      throw new Error('Staging branch recovery target is not the system Owner.');
    }

    const membership = await tx.tenantMembership.findFirst({
      where: { tenantId: tenant.id, userId: user.id },
      select: { id: true, status: true, defaultBranchId: true },
    });
    if (membership === null || membership.status !== 'active') {
      throw new Error('Staging branch recovery membership is unavailable.');
    }
    if (membership.defaultBranchId !== null) {
      console.info('Staging owner already has a default branch.');
      return;
    }

    const branches = await tx.branch.findMany({
      where: { tenantId: tenant.id, isActive: true },
      select: { id: true },
      orderBy: { code: 'asc' },
      take: 2,
    });
    const branch = branches.at(0);
    if (branch === undefined) {
      throw new Error('Staging branch recovery found no active branch.');
    }
    if (branches.length !== 1) {
      throw new Error('Staging branch recovery refuses an ambiguous active branch set.');
    }

    const at = new Date();
    const changed = await tx.tenantMembership.updateMany({
      where: { id: membership.id, tenantId: tenant.id, defaultBranchId: null },
      data: { defaultBranchId: branch.id, updatedAt: at },
    });
    if (changed.count !== 1) {
      throw new Error('Staging branch recovery could not update the membership.');
    }

    await tx.auditEvent.create({
      data: {
        id: newId(),
        tenantId: tenant.id,
        actorUserId: null,
        branchId: branch.id,
        terminalId: null,
        eventType: 'staging.owner-default-branch.recovered',
        entityType: 'tenant_membership',
        entityId: membership.id,
        metadata: {
          userId: user.id,
          branchId: branch.id,
          reason: 'operator_recovery',
        },
        occurredAt: at,
      },
    });
  });

  console.info('Staging owner default branch recovery completed.');
}

/** Separate entrypoint: ordinary development startup is unaffected. */
async function start(): Promise<void> {
  const config = loadStagingConfig(process.env);
  const prisma = createPrismaClient(config.DATABASE_URL ?? '');
  try {
    await verifyStagingDatabase(prisma);
    await repairStagingDefaultBranchIfRequested(prisma);
  } finally {
    await prisma.$disconnect();
  }
  const app = buildServer(config);
  await app.listen({ host: '0.0.0.0', port: config.API_PORT });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 25_000);
    deadline.unref();
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

void start().catch(() => {
  // Driver errors can contain connection details. Never print the raw error.
  console.error('Staging startup refused. Check configuration, database role, migrations and RLS.');
  process.exitCode = 1;
});
