import { createAuthRepository, createPrismaClient, withTenant } from '@korvi/database';
import { assertNewPasswordAcceptable, createUuidV7Generator, normalizeEmail } from '@korvi/domain';
import { hashPassword } from './auth/password.js';
import { buildServer } from './server.js';
import { loadStagingConfig } from './staging/config.js';
import { verifyStagingDatabase } from './staging/preflight.js';
import type { PrismaClient } from '@korvi/database';

/**
 * Temporary staging-only operator recovery hook.
 *
 * This is intentionally unavailable to ordinary API routes. It only runs during
 * the isolated staging process startup when an explicit environment flag and
 * all three recovery inputs are present. The plaintext password never enters
 * the repository or a log line; only its scrypt hash reaches PostgreSQL.
 *
 * The hook is removed immediately after the one recovery deployment succeeds.
 */
async function recoverStagingOwnerIfRequested(prisma: PrismaClient): Promise<void> {
  if (process.env['KORVI_STAGING_OWNER_RECOVERY'] !== '1') return;

  const slug = process.env['KORVI_STAGING_RECOVERY_TENANT']?.trim() ?? '';
  const requestedEmail = process.env['KORVI_STAGING_RECOVERY_EMAIL'] ?? '';
  const password = process.env['KORVI_STAGING_RECOVERY_PASSWORD'] ?? '';
  const email = normalizeEmail(requestedEmail);

  if (slug === '' || email === '' || password === '') {
    throw new Error('Staging owner recovery configuration is incomplete.');
  }
  assertNewPasswordAcceptable(password);

  const tenant = await createAuthRepository(prisma).resolveTenantForLogin(slug);
  if (tenant === null || tenant.status !== 'active') {
    throw new Error('Staging owner recovery tenant is unavailable.');
  }

  // Deliberately outside the database transaction: scrypt is memory-hard and
  // must not hold tenant/role locks while deriving the credential.
  const passwordHash = await hashPassword(password);
  const ids = createUuidV7Generator();

  await withTenant(prisma, tenant.id, async (tx) => {
    const role = await tx.role.findFirst({
      where: { tenantId: tenant.id, key: 'owner', isSystem: true },
      select: { id: true },
    });
    if (role === null) throw new Error('Staging tenant has no system owner role.');

    const grants = await tx.userRole.findMany({
      where: { tenantId: tenant.id, roleId: role.id },
      select: { userId: true },
      take: 2,
    });
    if (grants.length > 1) {
      throw new Error('Staging owner recovery refuses an ambiguous owner set.');
    }

    const at = new Date();
    let userId = grants.at(0)?.userId;

    if (userId !== undefined) {
      const conflicting = await tx.user.findFirst({
        where: { tenantId: tenant.id, email, NOT: { id: userId } },
        select: { id: true },
      });
      if (conflicting !== null) {
        throw new Error('Staging owner recovery email is already bound to another user.');
      }

      const updated = await tx.user.updateMany({
        where: { id: userId, tenantId: tenant.id },
        data: {
          email,
          displayName: 'Korvi Staging Owner',
          passwordHash,
          isActive: true,
          failedLoginCount: 0,
          lockedUntil: null,
          authVersion: { increment: 1 },
          updatedAt: at,
        },
      });
      if (updated.count !== 1) throw new Error('Staging owner recovery could not update owner.');
    } else {
      const existing = await tx.user.findFirst({
        where: { tenantId: tenant.id, email },
        select: { id: true },
      });
      userId = existing?.id ?? ids.next();

      if (existing === null) {
        await tx.user.create({
          data: {
            id: userId,
            tenantId: tenant.id,
            email,
            displayName: 'Korvi Staging Owner',
            passwordHash,
            isActive: true,
            failedLoginCount: 0,
            lockedUntil: null,
            authVersion: 1,
            updatedAt: at,
          },
        });
      } else {
        const updated = await tx.user.updateMany({
          where: { id: userId, tenantId: tenant.id },
          data: {
            displayName: 'Korvi Staging Owner',
            passwordHash,
            isActive: true,
            failedLoginCount: 0,
            lockedUntil: null,
            authVersion: { increment: 1 },
            updatedAt: at,
          },
        });
        if (updated.count !== 1) throw new Error('Staging owner recovery could not claim user.');
      }

      await tx.userRole.create({
        data: { id: ids.next(), tenantId: tenant.id, userId, roleId: role.id },
      });
    }

    const membership = await tx.tenantMembership.findFirst({
      where: { tenantId: tenant.id, userId },
      select: { id: true },
    });
    if (membership === null) {
      await tx.tenantMembership.create({
        data: {
          id: ids.next(),
          tenantId: tenant.id,
          userId,
          status: 'active',
          updatedAt: at,
        },
      });
    } else {
      await tx.tenantMembership.updateMany({
        where: { id: membership.id, tenantId: tenant.id },
        data: { status: 'active', updatedAt: at },
      });
    }

    // Invalidate every old session after a credential recovery.
    await tx.session.updateMany({
      where: { tenantId: tenant.id, userId, revokedAt: null },
      data: { revokedAt: at },
    });
  });

  console.info('Staging owner credential recovery completed.');
}

/** Separate entrypoint: ordinary development startup is unaffected. */
async function start(): Promise<void> {
  const config = loadStagingConfig(process.env);
  const prisma = createPrismaClient(config.DATABASE_URL ?? '');
  try {
    await verifyStagingDatabase(prisma);
    await recoverStagingOwnerIfRequested(prisma);
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
