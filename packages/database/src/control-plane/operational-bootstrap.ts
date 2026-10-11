import { createHash } from 'node:crypto';
import {
  MerchantAdminError,
  OWNER_BOOTSTRAP_ROLE_KEY,
  newId,
  normalizeAdminCode,
  normalizeAdminName,
  normalizeControlPlaneActor,
  normalizeControlPlaneOperation,
  normalizeOptionalLine,
} from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { withTenant } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

/**
 * Initial branch/register provisioning performed by Korvi's SaaS control plane.
 *
 * This is intentionally not Merchant Admin. A platform operator is not a user
 * inside the merchant tenant, so the audit actor is null and the bounded
 * control-plane actor reference is recorded in metadata instead (ADR-0018).
 */
export const PLATFORM_OPERATIONAL_BOOTSTRAP_SCOPE = 'platform-operational-bootstrap';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PlatformOperationalBootstrapRefusal =
  | 'unknown-tenant'
  | 'tenant-suspended'
  | 'invalid-input'
  | 'branch-code-taken'
  | 'terminal-code-taken'
  | 'idempotency-conflict';

export class PlatformOperationalBootstrapRefusedError extends DatabaseError {
  public override readonly name = 'PlatformOperationalBootstrapRefusedError';
  public readonly detail: PlatformOperationalBootstrapRefusal;

  public constructor(detail: PlatformOperationalBootstrapRefusal) {
    super(`Platform operational bootstrap refused: ${detail}`);
    this.detail = detail;
  }
}

export interface PlatformOperationalBootstrapRequest {
  readonly tenantId: string;
  readonly operationId: string;
  readonly controlPlaneActorRef: string;
  readonly branch: {
    readonly code: string;
    readonly nameAr: string;
    readonly nameEn?: string | null | undefined;
  };
  readonly terminal: {
    readonly code: string;
    readonly label: string;
  };
}

export interface PlatformOperationalBootstrapResult {
  readonly branch: {
    readonly id: string;
    readonly code: string;
    readonly nameAr: string;
    readonly nameEn: string | null;
    readonly isActive: boolean;
  };
  readonly terminal: {
    readonly id: string;
    readonly branchId: string;
    readonly code: string;
    readonly label: string;
    readonly isActive: boolean;
  };
  readonly replayed: boolean;
}

interface NormalizedRequest {
  readonly tenantId: string;
  readonly operationId: string;
  readonly actorRef: string;
  readonly branch: {
    readonly code: string;
    readonly nameAr: string;
    readonly nameEn: string | null;
  };
  readonly terminal: {
    readonly code: string;
    readonly label: string;
  };
}

interface ReservationRow {
  requestHash: string | null;
  resultType: string | null;
  resultId: string | null;
}

interface TenantLockRow {
  id: string;
  status: string;
}

interface OperationalRow {
  terminalId: string;
  terminalCode: string;
  terminalLabel: string;
  terminalActive: boolean;
  branchId: string;
  branchCode: string;
  branchNameAr: string;
  branchNameEn: string | null;
  branchActive: boolean;
}

interface OwnerCandidateRow {
  userId: string;
}

function normalize(request: PlatformOperationalBootstrapRequest): NormalizedRequest {
  if (!UUID_PATTERN.test(request.tenantId)) {
    throw new PlatformOperationalBootstrapRefusedError('unknown-tenant');
  }

  try {
    return {
      tenantId: request.tenantId.toLowerCase(),
      operationId: normalizeControlPlaneOperation(request.operationId),
      actorRef: normalizeControlPlaneActor(request.controlPlaneActorRef),
      branch: {
        code: normalizeAdminCode(request.branch.code),
        nameAr: normalizeAdminName(request.branch.nameAr),
        nameEn: normalizeOptionalLine(request.branch.nameEn ?? null),
      },
      terminal: {
        code: normalizeAdminCode(request.terminal.code),
        label: normalizeAdminName(request.terminal.label),
      },
    };
  } catch (error) {
    if (error instanceof MerchantAdminError || error instanceof RangeError) {
      throw new PlatformOperationalBootstrapRefusedError('invalid-input');
    }
    throw error;
  }
}

function fingerprint(request: NormalizedRequest): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'platform.operational-bootstrap.v1',
        request.tenantId,
        request.actorRef,
        request.branch.code,
        request.branch.nameAr,
        request.branch.nameEn,
        request.terminal.code,
        request.terminal.label,
      ]),
      'utf8',
    )
    .digest('base64url');
}

async function readResult(
  tx: TransactionClient,
  tenantId: string,
  terminalId: string,
  replayed: boolean,
): Promise<PlatformOperationalBootstrapResult> {
  const rows = await tx.$queryRaw<OperationalRow[]>`
    SELECT
      t."id" AS "terminalId",
      t."code" AS "terminalCode",
      t."label" AS "terminalLabel",
      t."isActive" AS "terminalActive",
      b."id" AS "branchId",
      b."code" AS "branchCode",
      b."nameAr" AS "branchNameAr",
      b."nameEn" AS "branchNameEn",
      b."isActive" AS "branchActive"
    FROM "terminals" t
    JOIN "branches" b
      ON b."tenantId" = t."tenantId" AND b."id" = t."branchId"
    WHERE t."tenantId" = ${tenantId}::uuid
      AND t."id" = ${terminalId}::uuid
    LIMIT 1
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new DatabaseError('Platform operational bootstrap replay result is missing.');
  }
  return {
    branch: {
      id: row.branchId,
      code: row.branchCode,
      nameAr: row.branchNameAr,
      nameEn: row.branchNameEn,
      isActive: row.branchActive,
    },
    terminal: {
      id: row.terminalId,
      branchId: row.branchId,
      code: row.terminalCode,
      label: row.terminalLabel,
      isActive: row.terminalActive,
    },
    replayed,
  };
}

async function appendAudit(
  tx: TransactionClient,
  tenantId: string,
  eventType: string,
  entityType: string,
  entityId: string,
  actorRef: string,
  operationId: string,
  metadata: Readonly<Record<string, string>>,
  at: Date,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId,
      actorUserId: null,
      branchId: null,
      terminalId: null,
      eventType,
      entityType,
      entityId,
      metadata: { controlPlaneActorRef: actorRef, operationId, ...metadata },
      occurredAt: at,
    },
  });
}

/**
 * Bind the initial Owner to the first operational branch when that relationship
 * is unambiguous.
 *
 * Owner bootstrap intentionally creates identity before a merchant has to have
 * a branch. Cashier authority, however, is branch-pinned. Without this bridge a
 * correctly bootstrapped Owner can authenticate but cannot discover a terminal
 * or open the first shift because the session carries `branchId = null`.
 *
 * We never guess when multiple system Owners are present. The tenant row is
 * already locked by the caller; the candidate membership is also locked before
 * the update so this assignment participates in the same all-or-nothing
 * transaction as branch/register provisioning.
 */
async function bindInitialOwnerToBranch(
  tx: TransactionClient,
  tenantId: string,
  branchId: string,
  at: Date,
): Promise<string | null> {
  const candidates = await tx.$queryRaw<OwnerCandidateRow[]>`
    SELECT m."userId" AS "userId"
      FROM "tenant_memberships" m
      JOIN "user_roles" ur
        ON ur."tenantId" = m."tenantId" AND ur."userId" = m."userId"
      JOIN "roles" r
        ON r."tenantId" = ur."tenantId" AND r."id" = ur."roleId"
     WHERE m."tenantId" = ${tenantId}::uuid
       AND m."status" = 'active'
       AND m."defaultBranchId" IS NULL
       AND r."key" = ${OWNER_BOOTSTRAP_ROLE_KEY}
       AND r."isSystem" = true
     ORDER BY m."userId"
     LIMIT 2
     FOR UPDATE OF m
  `;

  if (candidates.length !== 1) return null;
  const owner = candidates[0];
  if (owner === undefined) return null;

  const changed = await tx.tenantMembership.updateMany({
    where: {
      tenantId,
      userId: owner.userId,
      status: 'active',
      defaultBranchId: null,
    },
    data: { defaultBranchId: branchId, updatedAt: at },
  });
  return changed.count === 1 ? owner.userId : null;
}

/**
 * Atomically create the first operational branch/register pair for a tenant.
 *
 * The target tenant is selected only after Platform authentication at the API
 * boundary. Inside the database we enter that tenant's ordinary RLS context;
 * no bypass role or merchant-user impersonation is introduced. Branch and
 * terminal creation, initial-Owner branch binding, audit evidence and the
 * idempotency completion record all commit or roll back together.
 */
export async function provisionTenantOperations(
  prisma: PrismaClient,
  request: PlatformOperationalBootstrapRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<PlatformOperationalBootstrapResult> {
  const input = normalize(request);
  const requestHash = fingerprint(input);

  return withTenant(prisma, input.tenantId, async (tx) => {
    const at = clock();
    // Serialize platform onboarding for this tenant. Merchant-side creation is
    // still protected independently by the tenant/code unique constraints.
    const locked = await tx.$queryRaw<TenantLockRow[]>`
      SELECT "id", "status"
      FROM "tenants"
      WHERE "id" = ${input.tenantId}::uuid
      FOR UPDATE
    `;
    const tenant = locked[0];
    if (tenant === undefined) {
      throw new PlatformOperationalBootstrapRefusedError('unknown-tenant');
    }

    const reservations = await tx.$queryRaw<ReservationRow[]>`
      SELECT "requestHash", "resultType", "resultId"
      FROM "idempotency_keys"
      WHERE "tenantId" = ${input.tenantId}::uuid
        AND "scope" = ${PLATFORM_OPERATIONAL_BOOTSTRAP_SCOPE}
        AND "operationId" = ${input.operationId}
      LIMIT 1
    `;
    const reservation = reservations[0];
    if (reservation !== undefined) {
      if (reservation.requestHash !== requestHash) {
        throw new PlatformOperationalBootstrapRefusedError('idempotency-conflict');
      }
      if (reservation.resultType !== 'terminal' || reservation.resultId === null) {
        throw new DatabaseError('Platform operational bootstrap reservation is corrupt.');
      }
      return readResult(tx, input.tenantId, reservation.resultId, true);
    }

    if (tenant.status === 'suspended') {
      throw new PlatformOperationalBootstrapRefusedError('tenant-suspended');
    }

    const branchId = nextId();
    const branchInserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "branches"
        ("id", "tenantId", "code", "nameAr", "nameEn", "isActive", "createdAt", "updatedAt")
      VALUES
        (${branchId}::uuid, ${input.tenantId}::uuid, ${input.branch.code}, ${input.branch.nameAr},
         ${input.branch.nameEn}, true, ${at}, ${at})
      ON CONFLICT ("tenantId", "code") DO NOTHING
      RETURNING "id"
    `;
    if (branchInserted.length !== 1) {
      throw new PlatformOperationalBootstrapRefusedError('branch-code-taken');
    }

    const terminalId = nextId();
    const terminalInserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "terminals"
        ("id", "tenantId", "branchId", "code", "label", "isActive", "createdAt", "updatedAt")
      VALUES
        (${terminalId}::uuid, ${input.tenantId}::uuid, ${branchId}::uuid, ${input.terminal.code},
         ${input.terminal.label}, true, ${at}, ${at})
      ON CONFLICT ("tenantId", "code") DO NOTHING
      RETURNING "id"
    `;
    if (terminalInserted.length !== 1) {
      throw new PlatformOperationalBootstrapRefusedError('terminal-code-taken');
    }

    const boundOwnerId = await bindInitialOwnerToBranch(tx, input.tenantId, branchId, at);

    await appendAudit(
      tx,
      input.tenantId,
      'platform.branch-provisioned',
      'branch',
      branchId,
      input.actorRef,
      input.operationId,
      { code: input.branch.code },
      at,
    );
    await appendAudit(
      tx,
      input.tenantId,
      'platform.terminal-provisioned',
      'terminal',
      terminalId,
      input.actorRef,
      input.operationId,
      { code: input.terminal.code, branchId },
      at,
    );
    if (boundOwnerId !== null) {
      await appendAudit(
        tx,
        input.tenantId,
        'platform.owner-default-branch-assigned',
        'user',
        boundOwnerId,
        input.actorRef,
        input.operationId,
        { branchId },
        at,
      );
    }

    await tx.$executeRaw`
      INSERT INTO "idempotency_keys"
        ("id", "tenantId", "scope", "operationId", "status", "resultType", "resultId",
         "requestHash", "completedAt")
      VALUES
        (${newId()}::uuid, ${input.tenantId}::uuid, ${PLATFORM_OPERATIONAL_BOOTSTRAP_SCOPE},
         ${input.operationId}, 'completed', 'terminal', ${terminalId}::uuid, ${requestHash}, ${at})
    `;

    return readResult(tx, input.tenantId, terminalId, false);
  });
}
