import {
  PERMISSIONS,
  TENANT_LIFECYCLE_STATES,
  isAlreadyInTargetState,
  lifecycleEventType,
  newId,
  nextTenantState,
  normalizeControlPlaneActor,
  normalizeControlPlaneOperation,
  normalizeSuspensionReason,
} from '@korvi/domain';
import { normalizeTenantSlug, withLoginSlug, withTenant } from '../tenant-context.js';
import { DatabaseError, TenantLifecycleRefusedError, TenantProvisioningError } from '../errors.js';
import { oneOf } from '../repositories/mapping.js';
import { provisionTenantRbacWithin } from './rbac.js';
import { fingerprintLifecycle, fingerprintProvisioning } from './fingerprint.js';
import type { Permission, RoleName, TenantLifecycleState, Vertical } from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';
import type { ProvisionedRole } from './rbac.js';

/**
 * The SaaS control plane.
 *
 * Trusted and internal. Nothing here is reachable over HTTP, and nothing here
 * takes a tenant id from a request body — a caller of `provisionTenant` does
 * not choose which tenant is created, and a caller of the lifecycle operations
 * has already been authorised by whatever admits it to this process.
 *
 * Two properties hold throughout, and both are the reason this file exists
 * rather than a handful of repository methods:
 *
 *   Provisioning is one transaction. A tenant with settings and no roles, or
 *   roles and no audit row, is a half-built merchant that somebody will later
 *   have to diagnose. There is no path here that can produce one.
 *
 *   Nothing bypasses RLS. Provisioning establishes the *new* tenant's own
 *   context and then writes its row, so the existing `tenants_isolation`
 *   WITH CHECK is satisfied rather than avoided; a provisioning replay is
 *   resolved through the existing FOR SELECT login-slug policy. No bypass
 *   role, no superuser, no policy weakened (ADR-0004, ADR-0018).
 */

const ROLE_NAMES: readonly RoleName[] = ['owner', 'admin', 'manager', 'cashier'];
const VERTICALS: readonly Vertical[] = ['retail', 'grocery', 'restaurant', 'pharmacy'];

/** Long enough for a Saudi commercial name in Arabic, bounded so it is a name. */
const MAX_TENANT_NAME = 200;

/** The idempotency scope every lifecycle mutation reserves under. */
export const TENANT_LIFECYCLE_SCOPE = 'tenant-lifecycle';

// ---------------------------------------------------------------------------
// Requests and results
// ---------------------------------------------------------------------------

export interface TenantProvisioningRequest {
  /** The control plane's own id for this attempt. Unique installation-wide. */
  readonly operationId: string;
  readonly slug: string;
  readonly name: string;
  readonly vatNumber: string | null;
  readonly vertical: Vertical;
  /**
   * Who asked, as an opaque bounded reference. Deliberately not a user id:
   * a platform operator is not a merchant's user, and minting a `User` row
   * inside the merchant's own data to satisfy a foreign key would put an
   * operator into that merchant's user list (ADR-0018).
   */
  readonly controlPlaneActorRef: string;
}

export interface ProvisionedTenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantLifecycleState;
  readonly roles: readonly ProvisionedRole[];
  /** False when this call resolved an earlier attempt rather than creating. */
  readonly created: boolean;
}

export interface TenantLifecycleRequest {
  readonly tenantId: string;
  readonly operationId: string;
  readonly controlPlaneActorRef: string;
}

export interface TenantSuspensionRequest extends TenantLifecycleRequest {
  /** Required, trimmed and bounded. A stop with no reason is not a record. */
  readonly reason: string;
}

export interface TenantLifecycleResult {
  readonly id: string;
  readonly status: TenantLifecycleState;
  /** False when this call replayed a reservation rather than moving anything. */
  readonly changed: boolean;
  /**
   * Sessions revoked *by this call*. A replay reports zero, because the
   * revocation happened in the transaction that first ran the operation; the
   * sessions are still revoked, this call is simply not what revoked them.
   */
  readonly revokedSessions: number;
}

// ---------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------

interface ReservationRow {
  requestHash: string | null;
}

/**
 * Reserve the operation id inside the caller's transaction.
 *
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING` rather than a read followed by
 * a write: two retries arriving together would both read "not reserved". When
 * it returns nothing, the competing transaction has definitely committed —
 * which is what makes it safe for the caller to go and read the result. Inside
 * the same transaction as the lifecycle change, so a rollback takes the
 * reservation with it and leaves no tombstone blocking a lawful retry
 * (ADR-0013, ADR-0017).
 */
async function reserveLifecycleOperation(
  tx: TransactionClient,
  tenant: string,
  operationId: string,
  requestHash: string,
  at: Date,
): Promise<boolean> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "idempotency_keys"
      ("id","tenantId","scope","operationId","status","resultType","resultId","requestHash","completedAt")
    VALUES (${newId()}::uuid, ${tenant}::uuid, ${TENANT_LIFECYCLE_SCOPE}, ${operationId},
            'completed', 'tenant', ${tenant}::uuid, ${requestHash}, ${at})
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
    RETURNING "id"`;
  return inserted.length === 1;
}

async function findReservation(
  tx: TransactionClient,
  tenant: string,
  operationId: string,
): Promise<ReservationRow | null> {
  const rows = await tx.$queryRaw<ReservationRow[]>`
    SELECT "requestHash" FROM "idempotency_keys"
     WHERE "tenantId" = ${tenant}::uuid
       AND "scope" = ${TENANT_LIFECYCLE_SCOPE}
       AND "operationId" = ${operationId}`;
  return rows[0] ?? null;
}

async function appendAudit(
  tx: TransactionClient,
  tenant: string,
  eventType: string,
  at: Date,
  metadata: Readonly<Record<string, string | number | null>>,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      // Null on purpose. The actor is a platform operator, and there is no
      // honest `User` row in this merchant to point at (ADR-0018).
      actorUserId: null,
      branchId: null,
      terminalId: null,
      eventType,
      entityType: 'tenant',
      entityId: tenant,
      metadata: { ...metadata },
      occurredAt: at,
    },
  });
}

async function readRoles(
  tx: TransactionClient,
  tenant: string,
): Promise<readonly ProvisionedRole[]> {
  const roles = await tx.role.findMany({ where: { tenantId: tenant }, orderBy: { key: 'asc' } });
  const out: ProvisionedRole[] = [];
  for (const role of roles) {
    const bindings = await tx.rolePermission.findMany({
      where: { tenantId: tenant, roleId: role.id },
      orderBy: { permissionKey: 'asc' },
    });
    out.push({
      key: oneOf(ROLE_NAMES, role.key, 'roles.key'),
      id: role.id,
      permissions: bindings.map((binding): Permission =>
        oneOf(PERMISSIONS, binding.permissionKey, 'role_permissions.permissionKey'),
      ),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

interface TenantEvidenceRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  provisioningOperationId: string | null;
  provisioningRequestHash: string | null;
}

/**
 * Everything a merchant needs to exist at all, in one transaction.
 *
 * What it establishes: the tenant row in `provisioning`, its settings, Korvi's
 * four default roles with their exact permission bindings, and one append-only
 * audit event. What it deliberately does not establish: branches, terminals and
 * users, which are 4B/4D's and are not needed for a tenant to be a tenant.
 *
 * The insert is `ON CONFLICT DO NOTHING` rather than a preflight read, for the
 * usual reason a preflight read is wrong: two identical attempts arriving
 * together would both find the slug free. When it writes nothing, one of the
 * two unique indexes has spoken and the resolution below reads the winner
 * through the login-slug policy — the one door in the tenancy boundary that
 * already exists for exactly this bootstrap problem (ADR-0012).
 *
 * `provisionPermissionCatalogue` must have run against this database first;
 * the permission keys are global and the role bindings reference them.
 */
export async function provisionTenant(
  prisma: PrismaClient,
  request: TenantProvisioningRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<ProvisionedTenant> {
  const slug = normalizeTenantSlug(request.slug);
  if (slug === '') throw new TenantProvisioningError('invalid-slug');

  const name = request.name.trim();
  if (name === '' || name.length > MAX_TENANT_NAME) {
    throw new TenantProvisioningError('invalid-name');
  }

  const actor = normalizeControlPlaneActor(request.controlPlaneActorRef);
  const operationId = normalizeControlPlaneOperation(request.operationId);
  const vertical = oneOf(VERTICALS, request.vertical, 'tenant_settings.vertical');
  const requestHash = fingerprintProvisioning({
    slug,
    name,
    vatNumber: request.vatNumber,
    vertical,
    controlPlaneActorRef: actor,
  });

  const id = nextId();
  const at = clock();

  const created = await withTenant(prisma, id, async (tx) => {
    // Under `tenants_isolation` this row is writable precisely because
    // `app.tenant_id` is already the id being inserted. That is the whole RLS
    // strategy for provisioning: satisfy the policy, do not go around it.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "tenants"
        ("id","name","slug","vatNumber","status","lifecycleProvenance",
         "provisioningOperationId","provisioningRequestHash","createdAt","updatedAt")
      VALUES (${id}::uuid, ${name}, ${slug}, ${request.vatNumber}, 'provisioning', 'recorded',
              ${operationId}, ${requestHash}, ${at}, ${at})
      ON CONFLICT DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 0) return null;

    await tx.tenantSettings.create({ data: { tenantId: id, vertical, updatedAt: at } });

    // In this transaction, not after it. A tenant whose roles were installed
    // by a second, independent transaction can exist with no roles.
    const roles = await provisionTenantRbacWithin(tx, id, nextId);

    await appendAudit(tx, id, 'tenant.provisioned', at, {
      controlPlaneActorRef: actor,
      operationId,
      slug,
      vertical,
    });

    return roles;
  });

  if (created !== null) {
    return { id, slug, name, status: 'provisioning', roles: created, created: true };
  }

  return resolveProvisioningConflict(prisma, slug, operationId, requestHash);
}

/**
 * Work out what the losing attempt should be told.
 *
 * Reached only after a unique index has already refused the insert, so none of
 * these answers is a guess about a race. The tenant is read through the
 * login-slug policy, which is FOR SELECT and matches exactly one row.
 */
async function resolveProvisioningConflict(
  prisma: PrismaClient,
  slug: string,
  operationId: string,
  requestHash: string,
): Promise<ProvisionedTenant> {
  const existing = await withLoginSlug(prisma, slug, async (tx) => {
    const rows = await tx.$queryRaw<TenantEvidenceRow[]>`
      SELECT "id","name","slug","status","provisioningOperationId","provisioningRequestHash"
        FROM "tenants" WHERE "slug" = ${slug}`;
    return rows[0] ?? null;
  });

  // Nothing holds the slug, so the index that refused the insert was the one on
  // the operation id: this id already created a tenant somewhere else, and
  // handing that merchant back would be an identity swap wearing a retry's
  // clothes.
  if (existing === null) throw new TenantProvisioningError('operation-id-reused');

  if (existing.provisioningOperationId !== operationId) {
    throw new TenantProvisioningError('slug-taken');
  }
  if (existing.provisioningRequestHash !== requestHash) {
    throw new TenantProvisioningError('request-mismatch');
  }

  const roles = await withTenant(prisma, existing.id, async (tx) => readRoles(tx, existing.id));

  return {
    id: existing.id,
    slug: existing.slug,
    name: existing.name,
    status: oneOf(TENANT_LIFECYCLE_STATES, existing.status, 'tenants.status'),
    roles,
    created: false,
  };
}

// ---------------------------------------------------------------------------
// Lifecycle mutations
// ---------------------------------------------------------------------------

interface TenantLockRow {
  id: string;
  status: string;
}

/**
 * One transition, with the tenant row held for the whole transaction.
 *
 * The lock is what makes every answer below a fact rather than a stale read.
 * Two operators suspending the same merchant at the same moment serialise on
 * this row, and the second one sees the first one's commit — which is why an
 * identical retry replays instead of being told the move is illegal.
 *
 * The order matters and mirrors the drawer's (ADR-0017): lock, then decide the
 * state question, then reserve, then write. A status check that ran before the
 * lock would be a guess, and a reservation taken before the state check would
 * leave a tombstone behind an illegal move.
 */
async function applyTransition(
  prisma: PrismaClient,
  transition: 'activate' | 'suspend' | 'reactivate',
  request: TenantLifecycleRequest,
  rawReason: string | null,
  clock: () => Date,
): Promise<TenantLifecycleResult> {
  const actor = normalizeControlPlaneActor(request.controlPlaneActorRef);
  const operationId = normalizeControlPlaneOperation(request.operationId);
  const reason = rawReason === null ? null : normalizeSuspensionReason(rawReason);
  const tenant = request.tenantId;
  const requestHash = fingerprintLifecycle({
    transition,
    tenantId: tenant,
    controlPlaneActorRef: actor,
    reason,
  });

  return withTenant(prisma, tenant, async (tx) => {
    const at = clock();
    const locked = await tx.$queryRaw<TenantLockRow[]>`
      SELECT "id","status" FROM "tenants" WHERE "id" = ${tenant}::uuid FOR UPDATE`;
    const row = locked[0];
    if (row === undefined) throw new TenantLifecycleRefusedError('unknown-tenant');

    const current = oneOf(TENANT_LIFECYCLE_STATES, row.status, 'tenants.status');

    // Already where this move lands. That is either a retry of the operation
    // that put it there — in which case the reservation says so and this call
    // replays — or a different operation asking for a move the machine does
    // not have, which fails closed.
    if (isAlreadyInTargetState(current, transition)) {
      const reservation = await findReservation(tx, tenant, operationId);
      if (reservation === null) throw new TenantLifecycleRefusedError('illegal-transition');
      if (reservation.requestHash !== requestHash) {
        throw new TenantLifecycleRefusedError('idempotency-conflict');
      }
      return { id: tenant, status: current, changed: false, revokedSessions: 0 };
    }

    // Pure, total, and the single definition of what may follow what. Throws
    // for every pair the table does not name.
    const next = ((): TenantLifecycleState => {
      try {
        return nextTenantState(current, transition);
      } catch {
        throw new TenantLifecycleRefusedError('illegal-transition');
      }
    })();

    if (!(await reserveLifecycleOperation(tx, tenant, operationId, requestHash, at))) {
      // The id is spoken for by an operation that has already committed, and
      // it was not this one — the state check above would have caught that.
      throw new TenantLifecycleRefusedError('idempotency-conflict');
    }

    // Suspension takes effect now, not at the next login. Same transaction as
    // the state change, so there is no window in which the tenant is stopped
    // and its sessions still authenticate.
    const revokedSessions =
      next === 'suspended'
        ? await tx.session.updateMany({
            where: { tenantId: tenant, revokedAt: null },
            data: { revokedAt: at },
          })
        : { count: 0 };

    const changed = await tx.tenant.updateMany({
      where: { id: tenant, status: current },
      data: {
        status: next,
        // Set once, on admission, and never cleared. `activatedAt` answers
        // "was this merchant ever admitted", which suspension does not undo.
        ...(transition === 'activate' ? { activatedAt: at } : {}),
        // Set together and cleared together: the row describes the present,
        // and the history of past suspensions lives in audit_events.
        suspendedAt: next === 'suspended' ? at : null,
        suspensionReason: next === 'suspended' ? reason : null,
        updatedAt: at,
      },
    });
    // Belt and braces over the row lock: if this is ever not 1, two writers
    // reached here holding the same row, which cannot happen.
    if (changed.count !== 1) {
      throw new DatabaseError('The tenant lifecycle update matched no row under its own lock.');
    }

    await appendAudit(tx, tenant, lifecycleEventType(transition), at, {
      controlPlaneActorRef: actor,
      operationId,
      fromStatus: current,
      toStatus: next,
      reason,
      revokedSessions: revokedSessions.count,
    });

    return { id: tenant, status: next, changed: true, revokedSessions: revokedSessions.count };
  });
}

/** provisioning -> active. The moment a merchant is admitted. */
export async function activateTenant(
  prisma: PrismaClient,
  request: TenantLifecycleRequest,
  clock: () => Date = () => new Date(),
): Promise<TenantLifecycleResult> {
  return applyTransition(prisma, 'activate', request, null, clock);
}

/**
 * active -> suspended, with every live session revoked in the same
 * transaction.
 */
export async function suspendTenant(
  prisma: PrismaClient,
  request: TenantSuspensionRequest,
  clock: () => Date = () => new Date(),
): Promise<TenantLifecycleResult> {
  return applyTransition(prisma, 'suspend', request, request.reason, clock);
}

/**
 * suspended -> active.
 *
 * It does not un-revoke anything, and there is no code path here that could:
 * `revokedAt` is only ever set, never cleared. A session revoked by a
 * suspension stays revoked, and the user signs in again (ADR-0018).
 */
export async function reactivateTenant(
  prisma: PrismaClient,
  request: TenantLifecycleRequest,
  clock: () => Date = () => new Date(),
): Promise<TenantLifecycleResult> {
  return applyTransition(prisma, 'reactivate', request, null, clock);
}
