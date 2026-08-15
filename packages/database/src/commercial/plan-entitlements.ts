import { createHash } from 'node:crypto';
import {
  COMMERCIAL_ACCOUNT_STATES,
  ENTITLEMENT_KINDS,
  newId,
  normalizeCommercialAccountState,
  normalizeControlPlaneActor,
  normalizeControlPlaneOperation,
  normalizeEntitlementKey,
  normalizeEntitlements,
  normalizePlanKey,
  normalizePlanRevision,
} from '@korvi/domain';
import { PlanEntitlementRefusedError, DatabaseError } from '../errors.js';
import { withTenant } from '../tenant-context.js';
import { oneOf, tenantParam } from '../repositories/mapping.js';
import type {
  CommercialAccountSnapshot,
  CommercialAccountState,
  EntitlementGrant,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

export const PLAN_ASSIGNMENT_EVENT = 'commercial.plan-assigned';

export interface CommercialPlanIntent {
  readonly tenantId: string;
  readonly planKey: string;
  readonly planRevision: number;
  readonly accountState: CommercialAccountState;
  readonly controlPlaneActorRef: string;
  readonly entitlements: readonly EntitlementGrant[];
}

export interface TenantPlanAssignmentRequest extends CommercialPlanIntent {
  readonly operationId: string;
}

export interface TenantPlanAssignmentResult extends CommercialAccountSnapshot {
  readonly tenantId: string;
  readonly operationId: string;
  readonly requestHash: string;
  readonly controlPlaneActorRef: string;
  readonly changed: boolean;
  /** Whether this assignment is still the account's current assignment now. */
  readonly current: boolean;
}

interface AssignmentRow {
  id: string;
  tenantId: string;
  operationId: string;
  requestHash: string;
  planKey: string;
  planRevision: number;
  accountState: string;
  controlPlaneActorRef: string;
  assignedAt: Date;
}

interface EntitlementRow {
  entitlementKey: string;
  kind: string;
  flagValue: boolean | null;
  limitValue: bigint | null;
}

function digest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/**
 * Canonical and order-independent over entitlement rows.
 *
 * The operation id is deliberately not part of the digest: it identifies the
 * attempt. The digest identifies what that attempt asked for.
 */
export function fingerprintCommercialPlanAssignment(intent: CommercialPlanIntent): string {
  const tenantId = intent.tenantId.trim().toLowerCase();
  const planKey = normalizePlanKey(intent.planKey);
  const planRevision = normalizePlanRevision(intent.planRevision);
  const accountState = normalizeCommercialAccountState(intent.accountState);
  const actor = normalizeControlPlaneActor(intent.controlPlaneActorRef);
  const grants = normalizeEntitlements(intent.entitlements);

  return digest(
    JSON.stringify([
      'tenant.plan-assignment.v1',
      tenantId,
      planKey,
      planRevision,
      accountState,
      actor,
      grants.map((grant) =>
        grant.kind === 'flag'
          ? [grant.key, 'flag', grant.enabled]
          : [grant.key, 'limit', grant.limit.toString()],
      ),
    ]),
  );
}

function persisted<T>(column: string, work: () => T): T {
  try {
    return work();
  } catch {
    throw new DatabaseError(`Persisted commercial column ${column} is invalid.`);
  }
}

async function readAssignmentWithin(
  tx: TransactionClient,
  tenantId: string,
  assignmentId: string,
): Promise<TenantPlanAssignmentResult> {
  const assignments = await tx.$queryRaw<AssignmentRow[]>`
    SELECT
      "id","tenantId","operationId","requestHash","planKey","planRevision",
      "accountState","controlPlaneActorRef","assignedAt"
      FROM "tenant_plan_assignments"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "id" = ${assignmentId}::uuid`;

  const row = assignments[0];
  if (row === undefined) {
    throw new DatabaseError('Current commercial assignment points at no assignment row.');
  }

  const entitlementRows = await tx.$queryRaw<EntitlementRow[]>`
    SELECT "entitlementKey","kind","flagValue","limitValue"
      FROM "tenant_plan_entitlements"
     WHERE "tenantId" = ${tenantId}::uuid
       AND "assignmentId" = ${assignmentId}::uuid
     ORDER BY "entitlementKey" ASC`;

  const grants: EntitlementGrant[] = entitlementRows.map((entitlement) => {
    const kind = oneOf(ENTITLEMENT_KINDS, entitlement.kind, 'tenant_plan_entitlements.kind');
    const key = persisted('tenant_plan_entitlements.entitlementKey', () =>
      normalizeEntitlementKey(entitlement.entitlementKey),
    );

    if (kind === 'flag') {
      if (entitlement.flagValue === null || entitlement.limitValue !== null) {
        throw new DatabaseError(`Flag entitlement "${key}" has an invalid stored shape.`);
      }
      return { key, kind: 'flag', enabled: entitlement.flagValue };
    }

    if (entitlement.flagValue !== null || entitlement.limitValue === null) {
      throw new DatabaseError(`Limit entitlement "${key}" has an invalid stored shape.`);
    }
    return { key, kind: 'limit', limit: entitlement.limitValue };
  });

  const currentRows = await tx.$queryRaw<{ currentAssignmentId: string }[]>`
    SELECT "currentAssignmentId"
      FROM "tenant_commercial_accounts"
     WHERE "tenantId" = ${tenantId}::uuid`;

  return {
    tenantId: row.tenantId,
    assignmentId: row.id,
    operationId: row.operationId,
    requestHash: row.requestHash,
    controlPlaneActorRef: row.controlPlaneActorRef,
    planKey: persisted('tenant_plan_assignments.planKey', () => normalizePlanKey(row.planKey)),
    planRevision: persisted('tenant_plan_assignments.planRevision', () =>
      normalizePlanRevision(row.planRevision),
    ),
    state: oneOf(
      COMMERCIAL_ACCOUNT_STATES,
      row.accountState,
      'tenant_plan_assignments.accountState',
    ),
    entitlements: persisted('tenant_plan_entitlements', () => normalizeEntitlements(grants)),
    assignedAt: row.assignedAt.toISOString(),
    changed: false,
    current: currentRows[0]?.currentAssignmentId === row.id,
  };
}

async function readCurrentWithin(
  tx: TransactionClient,
  tenantId: string,
): Promise<CommercialAccountSnapshot | null> {
  const accounts = await tx.$queryRaw<{ currentAssignmentId: string }[]>`
    SELECT "currentAssignmentId"
      FROM "tenant_commercial_accounts"
     WHERE "tenantId" = ${tenantId}::uuid`;

  const current = accounts[0];
  if (current === undefined) return null;

  const assignment = await readAssignmentWithin(tx, tenantId, current.currentAssignmentId);
  return {
    assignmentId: assignment.assignmentId,
    planKey: assignment.planKey,
    planRevision: assignment.planRevision,
    state: assignment.state,
    entitlements: assignment.entitlements,
    assignedAt: assignment.assignedAt,
  };
}

/**
 * Assign one immutable commercial snapshot and atomically make it current.
 *
 * The tenant row is the serialization boundary. Lifecycle transitions already
 * lock the same row, so a plan assignment and a lifecycle move cannot observe
 * half of one another. The two state machines remain semantically independent.
 */
export async function assignTenantPlan(
  prisma: PrismaClient,
  request: TenantPlanAssignmentRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<TenantPlanAssignmentResult> {
  const tenantId = request.tenantId.trim().toLowerCase();
  const operationId = normalizeControlPlaneOperation(request.operationId);
  const controlPlaneActorRef = normalizeControlPlaneActor(request.controlPlaneActorRef);
  const planKey = normalizePlanKey(request.planKey);
  const planRevision = normalizePlanRevision(request.planRevision);
  const accountState = normalizeCommercialAccountState(request.accountState);
  const entitlements = normalizeEntitlements(request.entitlements);

  const requestHash = fingerprintCommercialPlanAssignment({
    tenantId,
    planKey,
    planRevision,
    accountState,
    controlPlaneActorRef,
    entitlements,
  });

  return withTenant(prisma, tenantId, async (tx) => {
    const tenantRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id"
        FROM "tenants"
       WHERE "id" = ${tenantId}::uuid
       FOR UPDATE`;

    if (tenantRows.length !== 1) {
      throw new PlanEntitlementRefusedError('unknown-tenant');
    }

    const replayRows = await tx.$queryRaw<AssignmentRow[]>`
      SELECT
        "id","tenantId","operationId","requestHash","planKey","planRevision",
        "accountState","controlPlaneActorRef","assignedAt"
        FROM "tenant_plan_assignments"
       WHERE "tenantId" = ${tenantId}::uuid
         AND "operationId" = ${operationId}`;

    const replay = replayRows[0];
    if (replay !== undefined) {
      if (replay.requestHash !== requestHash) {
        throw new PlanEntitlementRefusedError('idempotency-conflict');
      }
      return readAssignmentWithin(tx, tenantId, replay.id);
    }

    const assignmentId = nextId();
    const at = clock();

    await tx.$executeRaw`
      INSERT INTO "tenant_plan_assignments"
        ("id","tenantId","operationId","requestHash","planKey","planRevision",
         "accountState","controlPlaneActorRef","assignedAt")
      VALUES
        (${assignmentId}::uuid, ${tenantId}::uuid, ${operationId}, ${requestHash},
         ${planKey}, ${planRevision}, ${accountState}, ${controlPlaneActorRef}, ${at})`;

    for (const grant of entitlements) {
      await tx.$executeRaw`
        INSERT INTO "tenant_plan_entitlements"
          ("id","tenantId","assignmentId","entitlementKey","kind",
           "flagValue","limitValue","createdAt")
        VALUES
          (${nextId()}::uuid, ${tenantId}::uuid, ${assignmentId}::uuid,
           ${grant.key}, ${grant.kind},
           ${grant.kind === 'flag' ? grant.enabled : null},
           ${grant.kind === 'limit' ? grant.limit : null},
           ${at})`;
    }

    await tx.$executeRaw`
      INSERT INTO "tenant_commercial_accounts"
        ("tenantId","currentAssignmentId","updatedAt")
      VALUES (${tenantId}::uuid, ${assignmentId}::uuid, ${at})
      ON CONFLICT ("tenantId") DO UPDATE
        SET "currentAssignmentId" = EXCLUDED."currentAssignmentId",
            "updatedAt" = EXCLUDED."updatedAt"`;

    await tx.auditEvent.create({
      data: {
        id: nextId(),
        tenantId,
        actorUserId: null,
        branchId: null,
        terminalId: null,
        eventType: PLAN_ASSIGNMENT_EVENT,
        entityType: 'tenant_plan_assignment',
        entityId: assignmentId,
        metadata: {
          controlPlaneActorRef,
          operationId,
          requestHash,
          planKey,
          planRevision,
          accountState,
          entitlements: entitlements.map((grant) =>
            grant.kind === 'flag'
              ? { key: grant.key, kind: grant.kind, enabled: grant.enabled }
              : { key: grant.key, kind: grant.kind, limit: grant.limit.toString() },
          ),
        },
        occurredAt: at,
      },
    });

    const result = await readAssignmentWithin(tx, tenantId, assignmentId);
    return { ...result, changed: true, current: true };
  });
}

/**
 * Runtime read boundary. The caller supplies a branded tenant scope, not a
 * request-body tenant id.
 */
export async function readCommercialAccount(
  prisma: PrismaClient,
  scope: TenantScope,
): Promise<CommercialAccountSnapshot | null> {
  const tenantId = tenantParam(scope);
  return withTenant(prisma, tenantId, (tx) => readCurrentWithin(tx, tenantId));
}
