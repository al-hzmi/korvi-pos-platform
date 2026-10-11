import { earnedLoyaltyPoints, newId } from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';

/**
 * Internal only — no public API to post points. The sole caller is the
 * transaction that finalizes the sale, after pricing/VAT/receipt persistence.
 * Eligibility is the authoritative sale NET after all ordinary discounts,
 * excluding VAT, not a client-provided basket estimate or tender amount.
 */
export async function earnLoyaltyWithin(
  tx: TransactionClient,
  tenant: string,
  sale: {
    readonly id: string;
    readonly customerId: string | null;
    readonly status: string;
    readonly netMinor: string;
    readonly userId: string;
    readonly branchId: string;
    readonly terminalId: string;
    readonly issuedAt: string;
  },
): Promise<void> {
  if (sale.status !== 'finalized' || sale.customerId === null) return;

  // Share-lock the policy until commit: pause and activation cannot race the
  // financial snapshot. A draft/paused program never creates an entry.
  const policies = await tx.$queryRaw<
    {
      id: string;
      status: string;
      revision: bigint;
      earnNumerator: bigint;
      earnDenominator: bigint;
      redeemValueMinorPerPoint: bigint;
    }[]
  >`
    SELECT "id", "status", "revision", "earnNumerator", "earnDenominator",
           "redeemValueMinorPerPoint"
      FROM "loyalty_programs"
     WHERE "tenantId" = ${tenant}::uuid
     FOR SHARE
  `;
  const policy = policies[0];
  if (policy?.status !== 'active') return;

  const membership = await tx.loyaltyEnrollment.findFirst({
    where: {
      tenantId: tenant,
      programId: policy.id,
      customerId: sale.customerId,
      isActive: true,
    },
    select: { id: true },
  });
  if (membership === null) return;
  const net = BigInt(sale.netMinor);
  const points = earnedLoyaltyPoints(net, {
    earnNumerator: policy.earnNumerator,
    earnDenominator: policy.earnDenominator,
    redeemValueMinorPerPoint: policy.redeemValueMinorPerPoint,
  });
  if (points === 0n) return;

  const entryId = newId();
  await tx.loyaltyPointEntry.create({
    data: {
      id: entryId,
      tenantId: tenant,
      programId: policy.id,
      enrollmentId: membership.id,
      customerId: sale.customerId,
      operationId: `sale:${sale.id}:earn`,
      kind: 'earn',
      pointsDelta: points,
      programRevision: policy.revision,
      earnNumerator: policy.earnNumerator,
      earnDenominator: policy.earnDenominator,
      redeemValueMinorPerPoint: policy.redeemValueMinorPerPoint,
      eligibleMinor: net,
      saleId: sale.id,
      occurredAt: new Date(sale.issuedAt),
    },
  });
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      actorUserId: sale.userId,
      branchId: sale.branchId,
      terminalId: sale.terminalId,
      eventType: 'loyalty.points.earned',
      entityType: 'loyalty-point-entry',
      entityId: entryId,
      metadata: { points: points.toString(), saleId: sale.id, basis: 'finalized-net-ex-vat' },
      occurredAt: new Date(sale.issuedAt),
    },
  });
}

/**
 * Original-sale refund compensation, under the existing FOR UPDATE sale lock.
 * Partial refunds reverse the cumulative proportion of ORIGINAL earned points
 * against the original net. The last full refund reverses exactly the
 * remaining points, not a separately rounded per-line guess.
 *
 * A refund must not fail because already-spent points cause loyalty debt.
 * Only an ordinary redemption is forbidden from over-drawing an account.
 */
export async function reverseEarnedLoyaltyWithin(
  tx: TransactionClient,
  tenant: string,
  input: {
    readonly saleId: string;
    readonly returnId: string;
    readonly actorUserId: string;
    readonly branchId: string;
    readonly terminalId: string;
    readonly issuedAt: Date;
  },
): Promise<void> {
  const earned = await tx.loyaltyPointEntry.findFirst({
    where: { tenantId: tenant, saleId: input.saleId, kind: 'earn' },
  });
  if (earned === null) return;
  const sale = await tx.sale.findFirst({
    where: { tenantId: tenant, id: input.saleId, status: 'finalized' },
    select: { netMinor: true },
  });
  if (sale === null || sale.netMinor <= 0n) return;

  // The current return has already been inserted. The sale-row lock, owned
  // by the caller, serializes every competing refund of this sale.
  const refunds = await tx.return.aggregate({
    where: { tenantId: tenant, saleId: input.saleId, status: 'finalized' },
    _sum: { netMinor: true },
  });
  const cumulative = refunds._sum.netMinor ?? 0n;
  const bounded = cumulative >= sale.netMinor ? sale.netMinor : cumulative;
  const targetReversed = (earned.pointsDelta * bounded) / sale.netMinor;
  const already = await tx.loyaltyPointEntry.aggregate({
    where: { tenantId: tenant, reversesEntryId: earned.id, kind: 'reverse-earn' },
    _sum: { pointsDelta: true },
  });
  const previouslyReversed = -(already._sum.pointsDelta ?? 0n);
  const additional = targetReversed - previouslyReversed;
  if (additional <= 0n) return;

  const entryId = newId();
  await tx.loyaltyPointEntry.create({
    data: {
      id: entryId,
      tenantId: tenant,
      programId: earned.programId,
      enrollmentId: earned.enrollmentId,
      customerId: earned.customerId,
      operationId: `return:${input.returnId}:reverse-earn`,
      kind: 'reverse-earn',
      pointsDelta: -additional,
      programRevision: earned.programRevision,
      earnNumerator: earned.earnNumerator,
      earnDenominator: earned.earnDenominator,
      redeemValueMinorPerPoint: earned.redeemValueMinorPerPoint,
      returnId: input.returnId,
      reversesEntryId: earned.id,
      occurredAt: input.issuedAt,
    },
  });
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      actorUserId: input.actorUserId,
      branchId: input.branchId,
      terminalId: input.terminalId,
      eventType: 'loyalty.points.earn-reversed',
      entityType: 'loyalty-point-entry',
      entityId: entryId,
      metadata: {
        points: additional.toString(),
        sourceSaleId: input.saleId,
        returnId: input.returnId,
        basis: 'original-sale-cumulative-net',
      },
      occurredAt: input.issuedAt,
    },
  });
}
