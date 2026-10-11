import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@korvi/domain';
import {
  acceptOwnerBootstrap,
  createPrismaClient,
  issueOwnerBootstrapInvitation,
  provisionPermissionCatalogue,
  provisionTenant,
  withTenant,
} from '../index.js';
import { provisionTenantOperations } from '../control-plane/operational-bootstrap.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const capabilitySigningMaterial = 'k'.repeat(48);
const ownerPassword = ['Order', 'Proof', 'Owner', 'Password', '9!'].join('-');

describe.skipIf(url === '')('owner bootstrap / operational bootstrap ordering, live', () => {
  let prisma: ReturnType<typeof createPrismaClient>;

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await prisma.$connect();
    await provisionPermissionCatalogue(prisma);
  }, 90_000);

  afterAll(async () => {
    if (prisma !== undefined) await prisma.$disconnect();
  });

  it('binds the Owner to the first branch when operations are provisioned before invitation acceptance', async () => {
    const run = newId().replaceAll('-', '').slice(-12);
    const tenant = await provisionTenant(prisma, {
      operationId: `order-tenant-${run}`,
      slug: `order-${run}`,
      name: `Ordering Proof ${run}`,
      vatNumber: null,
      vertical: 'retail',
      controlPlaneActorRef: 'platform:test/ordering-proof',
    });

    try {
      const operations = await provisionTenantOperations(prisma, {
        tenantId: tenant.id,
        operationId: `order-operations-${run}`,
        controlPlaneActorRef: 'platform:test/ordering-proof',
        branch: {
          code: 'BR-01',
          nameAr: 'الفرع الرئيسي',
          nameEn: 'Main branch',
        },
        terminal: {
          code: 'POS-01',
          label: 'الكاشير الرئيسي',
        },
      });

      const invitation = await issueOwnerBootstrapInvitation(prisma, capabilitySigningMaterial, {
        tenantId: tenant.id,
        operationId: `order-owner-${run}`,
        email: `owner-${run}@order.test`,
        displayName: 'Ordering Proof Owner',
        controlPlaneActorRef: 'platform:test/ordering-proof',
      });

      const accepted = await acceptOwnerBootstrap(
        prisma,
        capabilitySigningMaterial,
        invitation.capability,
        async () => 'test-hash-fixture',
        ownerPassword,
      );

      const evidence = await withTenant(prisma, tenant.id, async (tx) => {
        const membership = await tx.tenantMembership.findFirst({
          where: { tenantId: tenant.id, userId: accepted.userId },
          select: { defaultBranchId: true, status: true },
        });
        const audit = await tx.auditEvent.findFirst({
          where: {
            tenantId: tenant.id,
            eventType: 'owner-bootstrap.accepted',
            entityId: invitation.invitationId,
          },
          select: { metadata: true },
        });
        return { membership, audit };
      });

      expect(evidence.membership).toEqual({
        defaultBranchId: operations.branch.id,
        status: 'active',
      });
      expect(evidence.audit?.metadata).toMatchObject({
        userId: accepted.userId,
        defaultBranchId: operations.branch.id,
        credentialEstablished: true,
      });
    } finally {
      await withTenant(prisma, tenant.id, async (tx) => {
        await tx.tenant.deleteMany({ where: { id: tenant.id } });
      });
    }
  }, 90_000);
});
