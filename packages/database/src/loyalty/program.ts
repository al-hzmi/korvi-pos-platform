import { newId, validateLoyaltyPointsPolicy } from '@korvi/domain';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';

export type LoyaltyPolicyRefusal =
  | 'program-exists'
  | 'program-missing'
  | 'stale-revision'
  | 'invalid-policy'
  | 'policy-locked'
  | 'customer-unavailable'
  | 'not-consented'
  | 'already-enrolled'
  | 'program-inactive';

export class LoyaltyPolicyRefusedError extends Error {
  public override readonly name = 'LoyaltyPolicyRefusedError';
  public constructor(public readonly detail: LoyaltyPolicyRefusal) {
    super(detail);
  }
}

export interface LoyaltyActor {
  readonly userId: string;
}

export interface LoyaltyPolicyInput {
  readonly nameAr: string;
  readonly earnNumerator: string;
  readonly earnDenominator: string;
  readonly redeemValueMinorPerPoint: string;
}

export interface LoyaltyPolicyView extends LoyaltyPolicyInput {
  readonly id: string;
  readonly status: 'draft' | 'active' | 'paused';
  readonly revision: string;
}

export interface LoyaltyLedgerView {
  readonly customerId: string;
  readonly enrolled: boolean;
  readonly balancePoints: string;
  readonly entries: readonly {
    readonly id: string;
    readonly kind: string;
    readonly pointsDelta: string;
    readonly saleId: string | null;
    readonly returnId: string | null;
    readonly occurredAt: string;
  }[];
}

function validRate(value: string): bigint {
  if (!/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new LoyaltyPolicyRefusedError('invalid-policy');
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new LoyaltyPolicyRefusedError('invalid-policy');
  }
  return parsed;
}

function validPolicy(input: LoyaltyPolicyInput) {
  const nameAr = input.nameAr.trim();
  if (nameAr.length < 1 || nameAr.length > 120) {
    throw new LoyaltyPolicyRefusedError('invalid-policy');
  }
  const policy = {
    earnNumerator: validRate(input.earnNumerator),
    earnDenominator: validRate(input.earnDenominator),
    redeemValueMinorPerPoint: validRate(input.redeemValueMinorPerPoint),
  };
  validateLoyaltyPointsPolicy(policy);
  return { nameAr, ...policy };
}

function asView(row: {
  id: string;
  nameAr: string;
  status: string;
  revision: bigint;
  earnNumerator: bigint;
  earnDenominator: bigint;
  redeemValueMinorPerPoint: bigint;
}): LoyaltyPolicyView {
  if (row.status !== 'draft' && row.status !== 'active' && row.status !== 'paused') {
    throw new LoyaltyPolicyRefusedError('invalid-policy');
  }
  return {
    id: row.id,
    nameAr: row.nameAr,
    status: row.status,
    revision: row.revision.toString(),
    earnNumerator: row.earnNumerator.toString(),
    earnDenominator: row.earnDenominator.toString(),
    redeemValueMinorPerPoint: row.redeemValueMinorPerPoint.toString(),
  };
}

async function audit(
  tx: TransactionClient,
  tenantId: string,
  actor: LoyaltyActor,
  eventType: string,
  entityId: string,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId,
      actorUserId: actor.userId,
      branchId: null,
      terminalId: null,
      eventType,
      entityType: 'loyalty-program',
      entityId,
      metadata: {},
      occurredAt: new Date(),
    },
  });
}

export async function readLoyaltyPolicy(
  prisma: PrismaClient,
  scope: TenantScope,
): Promise<LoyaltyPolicyView | null> {
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const row = await tx.loyaltyProgram.findUnique({
      where: { tenantId: tenantParam(scope) },
    });
    return row === null ? null : asView(row);
  });
}

export async function createLoyaltyPolicy(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: LoyaltyActor,
  input: LoyaltyPolicyInput,
): Promise<LoyaltyPolicyView> {
  const tenant = tenantParam(scope);
  const policy = validPolicy(input);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const existing = await tx.loyaltyProgram.findUnique({ where: { tenantId: tenant } });
    if (existing !== null) throw new LoyaltyPolicyRefusedError('program-exists');
    const row = await tx.loyaltyProgram.create({
      data: {
        id: newId(),
        tenantId: tenant,
        status: 'draft',
        revision: 1n,
        ...policy,
      },
    });
    await audit(tx, tenant, actor, 'loyalty.program.created', row.id);
    return asView(row);
  });
}

export async function reviseLoyaltyPolicy(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: LoyaltyActor,
  expectedRevision: string,
  update: Partial<LoyaltyPolicyInput> & { readonly status?: 'draft' | 'active' | 'paused' },
): Promise<LoyaltyPolicyView> {
  const tenant = tenantParam(scope);
  const revision = validRate(expectedRevision);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const previous = await tx.loyaltyProgram.findUnique({ where: { tenantId: tenant } });
    if (previous === null) throw new LoyaltyPolicyRefusedError('program-missing');
    if (previous.revision !== revision) throw new LoyaltyPolicyRefusedError('stale-revision');
    const policy = validPolicy({
      nameAr: update.nameAr ?? previous.nameAr,
      earnNumerator: update.earnNumerator ?? previous.earnNumerator.toString(),
      earnDenominator: update.earnDenominator ?? previous.earnDenominator.toString(),
      redeemValueMinorPerPoint:
        update.redeemValueMinorPerPoint ?? previous.redeemValueMinorPerPoint.toString(),
    });

    if (update.status === 'draft' && previous.status !== 'draft') {
      throw new LoyaltyPolicyRefusedError('policy-locked');
    }
    if (
      previous.status === 'active' &&
      (policy.earnNumerator !== previous.earnNumerator ||
        policy.earnDenominator !== previous.earnDenominator ||
        policy.redeemValueMinorPerPoint !== previous.redeemValueMinorPerPoint)
    ) {
      throw new LoyaltyPolicyRefusedError('policy-locked');
    }
    if (policy.redeemValueMinorPerPoint !== previous.redeemValueMinorPerPoint) {
      const historyCount = await tx.loyaltyPointEntry.count({ where: { tenantId: tenant } });
      if (historyCount > 0) throw new LoyaltyPolicyRefusedError('policy-locked');
    }

    const changed = await tx.loyaltyProgram.updateMany({
      where: { tenantId: tenant, revision },
      data: {
        ...policy,
        ...(update.status === undefined ? {} : { status: update.status }),
        revision: { increment: 1n },
      },
    });
    if (changed.count !== 1) throw new LoyaltyPolicyRefusedError('stale-revision');
    await audit(tx, tenant, actor, 'loyalty.program.updated', previous.id);
    const row = await tx.loyaltyProgram.findUnique({ where: { tenantId: tenant } });
    if (row === null) throw new LoyaltyPolicyRefusedError('program-missing');
    return asView(row);
  });
}

export async function enrollLoyaltyCustomer(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: LoyaltyActor,
  customerId: string,
  consentConfirmed: boolean,
): Promise<string> {
  if (!consentConfirmed) throw new LoyaltyPolicyRefusedError('not-consented');
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const program = await tx.loyaltyProgram.findUnique({ where: { tenantId: tenant } });
    if (program?.status !== 'active') throw new LoyaltyPolicyRefusedError('program-inactive');
    const customer = await tx.customer.findFirst({
      where: { tenantId: tenant, id: customerId, isActive: true },
      select: { id: true },
    });
    if (customer === null) throw new LoyaltyPolicyRefusedError('customer-unavailable');
    const existing = await tx.loyaltyEnrollment.findUnique({
      where: { tenantId_customerId: { tenantId: tenant, customerId } },
    });
    if (existing !== null) throw new LoyaltyPolicyRefusedError('already-enrolled');
    const row = await tx.loyaltyEnrollment.create({
      data: {
        id: newId(),
        tenantId: tenant,
        programId: program.id,
        customerId,
        consentedAt: new Date(),
        consentedByUserId: actor.userId,
        isActive: true,
      },
    });
    await audit(tx, tenant, actor, 'loyalty.customer.enrolled', row.id);
    return row.id;
  });
}

export async function readLoyaltyLedger(
  prisma: PrismaClient,
  scope: TenantScope,
  customerId: string,
): Promise<LoyaltyLedgerView> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const enrollment = await tx.loyaltyEnrollment.findUnique({
      where: { tenantId_customerId: { tenantId: tenant, customerId } },
    });
    if (enrollment === null) {
      return { customerId, enrolled: false, balancePoints: '0', entries: [] };
    }
    const [balance, entries] = await Promise.all([
      tx.loyaltyPointEntry.aggregate({
        where: { tenantId: tenant, enrollmentId: enrollment.id },
        _sum: { pointsDelta: true },
      }),
      tx.loyaltyPointEntry.findMany({
        where: { tenantId: tenant, enrollmentId: enrollment.id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: {
          id: true,
          kind: true,
          pointsDelta: true,
          saleId: true,
          returnId: true,
          occurredAt: true,
        },
      }),
    ]);
    return {
      customerId,
      enrolled: enrollment.isActive,
      balancePoints: (balance._sum.pointsDelta ?? 0n).toString(),
      entries: entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        pointsDelta: entry.pointsDelta.toString(),
        saleId: entry.saleId,
        returnId: entry.returnId,
        occurredAt: entry.occurredAt.toISOString(),
      })),
    };
  });
}
