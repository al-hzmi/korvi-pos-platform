import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@korvi/domain';
import { createPrismaClient } from '../client.js';
import { withTenant } from '../tenant-context.js';
import { readOperationSnapshot, writeOperationSnapshot } from '../purchasing/snapshot.js';
import type { PrismaClient } from '../client.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const T = {
  tenant: '018f5b10-0000-7000-8000-00000000000a',
  slug: 'purchasing-snapshot-live',
} as const;

describe.skipIf(url === '')('purchasing operation snapshot, live', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createPrismaClient(url);
    await withTenant(prisma, T.tenant, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: T.tenant } });
      await tx.tenant.create({
        data: {
          id: T.tenant,
          name: 'Snapshot Test',
          slug: T.slug,
          status: 'active',
          activatedAt: new Date(),
          updatedAt: new Date(),
        },
      });
    });
  });

  afterAll(async () => {
    await withTenant(prisma, T.tenant, async (tx) => {
      await tx.tenant.deleteMany({ where: { id: T.tenant } });
    });
    await prisma.$disconnect();
  });

  it('is mechanically write-once and preserves the first committed answer', async () => {
    const operationId = `snapshot-once-${newId()}`;
    const scope = 'purchasing-receipt-create';
    const first = { id: newId(), status: 'partially_received', quantity: '1000' };
    const second = { id: first.id, status: 'received', quantity: '9999' };

    await withTenant(prisma, T.tenant, async (tx) => {
      await tx.idempotencyKey.create({
        data: {
          id: newId(),
          tenantId: T.tenant,
          scope,
          operationId,
          status: 'completed',
          resultType: 'purchase-receipt',
          resultId: first.id,
          requestHash: 'x'.repeat(43),
          completedAt: new Date(),
        },
      });
      await writeOperationSnapshot(tx, T.tenant, scope, operationId, first);
    });

    await expect(
      withTenant(prisma, T.tenant, (tx) =>
        writeOperationSnapshot(tx, T.tenant, scope, operationId, second),
      ),
    ).rejects.toThrow(/Expected exactly one idempotency reservation to snapshot/);

    const stored = await withTenant(prisma, T.tenant, (tx) =>
      readOperationSnapshot(tx, T.tenant, scope, operationId),
    );
    expect(stored).toEqual(first);
  });

  it('treats a missing committed purchasing snapshot as an internal invariant failure', async () => {
    const operationId = `snapshot-missing-${newId()}`;
    const scope = 'purchasing-order-create';

    await withTenant(prisma, T.tenant, async (tx) => {
      await tx.idempotencyKey.create({
        data: {
          id: newId(),
          tenantId: T.tenant,
          scope,
          operationId,
          status: 'completed',
          resultType: 'purchase-order',
          resultId: newId(),
          requestHash: 'y'.repeat(43),
          completedAt: new Date(),
        },
      });
    });

    const failed = await withTenant(prisma, T.tenant, async (tx) => {
      try {
        await readOperationSnapshot(tx, T.tenant, scope, operationId);
      } catch (error) {
        return error;
      }
      throw new Error('expected snapshot invariant failure');
    });

    expect(failed).toBeInstanceOf(Error);
    expect((failed as Error).message).toContain('Purchasing snapshot invariant failure');
    expect((failed as Error).message).toContain(scope);
    expect((failed as Error).message).not.toContain('idempotency-conflict');
  });
});
