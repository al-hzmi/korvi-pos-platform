import {
  ADMINISTRATIVE_AUTHORITY,
  MAX_ADMIN_LIST_PAGE,
  MAX_ASSIGNABLE_ROLES,
  activationEvent,
  assertAdministrativeAuthorityRemains,
  newId,
} from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { DatabaseError, MerchantAdminRefusedError } from '../errors.js';
import { iso, isoOrNull, tenantParam } from '../repositories/mapping.js';
import type {
  AdministrativeCandidate,
  MerchantAdminEvent,
  Permission,
  TenantScope,
} from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

/**
 * Merchant administration authority.
 *
 * The merchant's own owner/admin changing their own shop: settings, branches,
 * tills, people and what those people may do. Everything here is tenant-scoped
 * and runs inside `withTenant`, so PostgreSQL — not a `WHERE` clause somebody
 * remembered — is what keeps one merchant out of another's rows.
 *
 * Three rules hold throughout, and they are why this is a module rather than a
 * handful of repository methods:
 *
 *   The tenant and the actor are arguments the caller derived from a verified
 *   session. Nothing in this file reads an id out of a request body, and there
 *   is no function here that takes a tenant id and a role and does what it is
 *   told.
 *
 *   A change to who may do what commits together with its security consequence
 *   and its audit row. Deactivating a user and revoking that user's sessions
 *   are one transaction, because between two transactions is a window in which
 *   a disabled account is still selling.
 *
 *   A change that would leave the merchant unable to administer itself is
 *   refused, measured on the state the transaction has already written, under
 *   a lock on the tenant row (ADR-0019).
 *
 * This is *not* the 4A control plane. A merchant administrator cannot provision,
 * activate, suspend or reactivate a tenant, and nothing in this file can.
 */

// ---------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------

export interface AdminActor {
  /** The authenticated merchant user. Never a value from a request body. */
  readonly userId: string;
}

/**
 * Take the tenant row for the duration of an authority-changing transaction.
 *
 * The row is not being changed — it is the serialization point. Two operators
 * each removing a different administrator would otherwise both measure a
 * healthy post-state, because neither can see the other's uncommitted write,
 * and the merchant would end up locked out by two individually safe requests.
 *
 * Only the operations that can *reduce* administrative authority take it.
 * Creating a branch does not need to wait behind a role assignment.
 */
/**
 * Take a branch row for the duration of a transaction that depends on whether
 * that branch is trading.
 *
 * The order is **branches, then terminals**, then shifts — the same order
 * `ShiftRepository.open` uses and the same order ADR-0017 documents for every
 * financial path. Because opening a shift takes this row first, holding it here
 * is what makes "no open shift" a fact at commit time rather than a stale read:
 * an opening either commits before this transaction starts, and is seen, or
 * waits behind it and then finds the branch stood down.
 */
async function lockBranch(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
): Promise<{ id: string; isActive: boolean }> {
  const rows = await tx.$queryRaw<{ id: string; isActive: boolean }[]>`
    SELECT "id", "isActive" FROM "branches"
     WHERE "id" = ${branchId}::uuid AND "tenantId" = ${tenant}::uuid
     FOR UPDATE`;
  const branch = rows.at(0);
  if (branch === undefined) throw new MerchantAdminRefusedError('unknown-branch');
  return branch;
}

/** Second in the order, after the branch. Never taken before one. */
async function lockTerminal(
  tx: TransactionClient,
  tenant: string,
  terminalId: string,
): Promise<{ id: string; branchId: string; code: string; isActive: boolean }> {
  const rows = await tx.$queryRaw<
    { id: string; branchId: string; code: string; isActive: boolean }[]
  >`
    SELECT "id", "branchId", "code", "isActive" FROM "terminals"
     WHERE "id" = ${terminalId}::uuid AND "tenantId" = ${tenant}::uuid
     FOR UPDATE`;
  const terminal = rows.at(0);
  if (terminal === undefined) throw new MerchantAdminRefusedError('unknown-terminal');
  return terminal;
}

async function lockTenant(tx: TransactionClient, tenant: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "tenants" WHERE "id" = ${tenant}::uuid FOR UPDATE`;
  if (rows.length !== 1) {
    // Unreachable through a verified session: the scope came from a row that
    // was read to authenticate this request.
    throw new DatabaseError('The tenant behind this session could not be locked.');
  }
}

async function appendAudit(
  tx: TransactionClient,
  tenant: string,
  actor: AdminActor,
  eventType: MerchantAdminEvent,
  entityType: string,
  entityId: string,
  metadata: Readonly<Record<string, string | number | boolean | null>>,
  at: Date,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      // The merchant's own administrator, from the session. A control-plane
      // operator would be null here; this never is (ADR-0018, ADR-0019).
      actorUserId: actor.userId,
      branchId: null,
      terminalId: null,
      eventType,
      entityType,
      entityId,
      metadata: { ...metadata },
      occurredAt: at,
    },
  });
}

/**
 * Everyone who could still administer this tenant, as the transaction now
 * stands.
 *
 * Only users who hold the authority through some role are fetched; whether
 * each of them is *viable* is the domain's rule, not this query's. Keeping the
 * definition in `@korvi/domain` is what stops a second, subtly different
 * version of "is an administrator" appearing the next time somebody needs one.
 */
async function administrativeCandidates(
  tx: TransactionClient,
  tenant: string,
): Promise<readonly AdministrativeCandidate[]> {
  const permission: Permission = ADMINISTRATIVE_AUTHORITY;
  const rows = await tx.$queryRaw<
    { userId: string; userActive: boolean; membershipActive: boolean }[]
  >`
    SELECT DISTINCT u."id" AS "userId",
           u."isActive" AS "userActive",
           (COALESCE(m."status", '') = 'active') AS "membershipActive"
      FROM "users" u
      JOIN "user_roles" ur
        ON ur."tenantId" = u."tenantId" AND ur."userId" = u."id"
      JOIN "role_permissions" rp
        ON rp."tenantId" = ur."tenantId" AND rp."roleId" = ur."roleId"
      LEFT JOIN "tenant_memberships" m
        ON m."tenantId" = u."tenantId" AND m."userId" = u."id"
     WHERE u."tenantId" = ${tenant}::uuid
       AND rp."permissionKey" = ${permission}`;
  return rows;
}

/**
 * Refuse a change that has locked the merchant out of its own administration.
 *
 * Called after the write, before the commit, so the thing being measured is
 * the outcome rather than a prediction of it.
 */
async function assertStillAdministrable(tx: TransactionClient, tenant: string): Promise<void> {
  try {
    assertAdministrativeAuthorityRemains(await administrativeCandidates(tx, tenant));
  } catch {
    throw new MerchantAdminRefusedError('last-administrator');
  }
}

/**
 * Stop every session this user is holding, now, in the caller's transaction.
 *
 * `revokedAt` is only ever set and never cleared, here or anywhere else, which
 * is what makes "reactivation does not resurrect a session" structural rather
 * than a rule somebody has to remember (ADR-0012, ADR-0019).
 */
async function revokeSessionsFor(
  tx: TransactionClient,
  tenant: string,
  userId: string,
  at: Date,
): Promise<number> {
  const changed = await tx.session.updateMany({
    where: { tenantId: tenant, userId, revokedAt: null },
    data: { revokedAt: at },
  });
  return changed.count;
}

function pageSize(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_ADMIN_LIST_PAGE);
}

/**
 * Keyset continuation, over a column that is already unique within the tenant.
 *
 * Branches and tills are ordered by `code` and members by `email`, and each of
 * those carries a `(tenantId, …)` unique index — so one column is a total order
 * and a single-value cursor is complete. No offset, which would skip or repeat
 * rows the moment somebody adds a branch while an administrator is paging.
 *
 * The cursor is base64url of that key. Encoding it is not secrecy — a branch
 * code is not a secret — it is a statement that the value is the server's to
 * interpret and not a field a client should compose. It carries no tenant and
 * no actor: the scope comes from the session, and a cursor from another
 * merchant is simply a string that sorts somewhere, inside this merchant's own
 * rows.
 */
function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

const MAX_CURSOR_BYTES = 512;

function decodeCursor(cursor: string | null): string | null {
  if (cursor === null || cursor === '') return null;
  if (cursor.length > MAX_CURSOR_BYTES) {
    throw new MerchantAdminRefusedError('invalid-cursor');
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  // Round-tripping is the check. Anything that is not base64url decodes to
  // something that does not re-encode to itself, and is refused rather than
  // silently treated as "start from the beginning" — a caller paging with a
  // corrupted cursor should be told, not quietly restarted.
  if (decoded === '' || encodeCursor(decoded) !== cursor) {
    throw new MerchantAdminRefusedError('invalid-cursor');
  }
  return decoded;
}

/**
 * One extra row is read and never returned: it is the answer to "is there
 * more?", and its absence is what makes `nextCursor` null rather than a cursor
 * onto an empty page.
 */
function paginate<T>(rows: readonly T[], limit: number, keyOf: (row: T) => string): AdminPage<T> {
  const items = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor(keyOf(last)) : null,
  };
}

// ---------------------------------------------------------------------------
// Tenant settings
// ---------------------------------------------------------------------------

/**
 * `?: T | undefined` rather than `?: T`, because under
 * `exactOptionalPropertyTypes` those are different types and the wider one is
 * what a parsed request body produces. Absent leaves a field alone; null
 * clears it, and the two must stay tellable apart or a set receipt footer
 * becomes permanent.
 */
export interface TenantSettingsPatch {
  readonly requireBarcode?: boolean | undefined;
  readonly allowWeightedItems?: boolean | undefined;
  readonly trackInventory?: boolean | undefined;
  readonly allowNegativeStock?: boolean | undefined;
  readonly enableProductImages?: boolean | undefined;
  /** Trimmed and bounded by the domain; null clears the line. */
  readonly receiptHeaderAr?: string | null | undefined;
  readonly receiptFooterAr?: string | null | undefined;
}

export interface AdminTenantSettings {
  readonly tenantId: string;
  readonly vertical: string;
  readonly priceMode: string;
  readonly defaultVatBasisPoints: number;
  readonly currency: string;
  readonly requireBarcode: boolean;
  readonly allowWeightedItems: boolean;
  readonly trackInventory: boolean;
  readonly allowNegativeStock: boolean;
  readonly enableProductImages: boolean;
  readonly receiptHeaderAr: string | null;
  readonly receiptFooterAr: string | null;
}

interface SettingsRow {
  tenantId: string;
  vertical: string;
  priceMode: string;
  defaultVatBasisPoints: number;
  currency: string;
  requireBarcode: boolean;
  allowWeightedItems: boolean;
  trackInventory: boolean;
  allowNegativeStock: boolean;
  enableProductImages: boolean;
  receiptHeaderAr: string | null;
  receiptFooterAr: string | null;
}

function settingsToDomain(row: SettingsRow): AdminTenantSettings {
  return {
    tenantId: row.tenantId,
    vertical: row.vertical,
    priceMode: row.priceMode,
    defaultVatBasisPoints: row.defaultVatBasisPoints,
    currency: row.currency,
    requireBarcode: row.requireBarcode,
    allowWeightedItems: row.allowWeightedItems,
    trackInventory: row.trackInventory,
    allowNegativeStock: row.allowNegativeStock,
    enableProductImages: row.enableProductImages,
    receiptHeaderAr: row.receiptHeaderAr,
    receiptFooterAr: row.receiptFooterAr,
  };
}

/**
 * Update the settings a merchant administrator is allowed to change.
 *
 * `vertical`, `priceMode`, `defaultVatBasisPoints` and `currency` are absent
 * from the patch on purpose. Each of them silently re-prices or re-taxes every
 * sale that follows, and two of them would change how existing receipts should
 * be read. They are not merchant self-service in 4B-1, and a field that is not
 * in the type cannot be set by a field that is not in the type.
 *
 * The tenant's lifecycle status is likewise unreachable from here. It is 4A's,
 * and it is not a setting.
 */
export async function updateTenantSettings(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  patch: TenantSettingsPatch,
  clock: () => Date = () => new Date(),
): Promise<AdminTenantSettings> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    // Spread key by key rather than `...patch`. Under
    // `exactOptionalPropertyTypes` a present key holding `undefined` is a
    // different thing from an absent one, and Prisma reads the first as "set
    // this column to its default", which is not what an untouched field means.
    const changed = await tx.tenantSettings.updateMany({
      where: { tenantId: tenant },
      data: {
        ...(patch.requireBarcode === undefined ? {} : { requireBarcode: patch.requireBarcode }),
        ...(patch.allowWeightedItems === undefined
          ? {}
          : { allowWeightedItems: patch.allowWeightedItems }),
        ...(patch.trackInventory === undefined ? {} : { trackInventory: patch.trackInventory }),
        ...(patch.allowNegativeStock === undefined
          ? {}
          : { allowNegativeStock: patch.allowNegativeStock }),
        ...(patch.enableProductImages === undefined
          ? {}
          : { enableProductImages: patch.enableProductImages }),
        ...(patch.receiptHeaderAr === undefined ? {} : { receiptHeaderAr: patch.receiptHeaderAr }),
        ...(patch.receiptFooterAr === undefined ? {} : { receiptFooterAr: patch.receiptFooterAr }),
        updatedAt: at,
      },
    });
    if (changed.count !== 1) {
      // A tenant provisioned by 4A always has settings. One that does not is a
      // half-built merchant, and answering "updated" would be a lie.
      throw new MerchantAdminRefusedError('unknown-member');
    }

    const row = await tx.tenantSettings.findFirst({ where: { tenantId: tenant } });
    if (row === null) throw new DatabaseError('The settings just written could not be read back.');

    await appendAudit(
      tx,
      tenant,
      actor,
      'tenant.settings.updated',
      'tenant_settings',
      tenant,
      // The field names that changed, not their values: a receipt footer is
      // the merchant's text and an audit row is the most widely read table in
      // any support incident.
      { fields: Object.keys(patch).sort().join(',') },
      at,
    );

    return settingsToDomain(row);
  });
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export interface AdminBranch {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
}

interface BranchRow {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  isActive: boolean;
  createdAt: Date;
}

function branchToDomain(row: BranchRow): AdminBranch {
  return {
    id: row.id,
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    isActive: row.isActive,
    createdAt: iso(row.createdAt),
  };
}

export interface AdminPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  /** Pass back as `cursor` to get the next page. Null when this is the last. */
  readonly nextCursor: string | null;
}

export async function listBranches(
  prisma: PrismaClient,
  scope: TenantScope,
  limit: number,
  cursor: string | null = null,
): Promise<AdminPage<AdminBranch>> {
  const size = pageSize(limit);
  const after = decodeCursor(cursor);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    // One more than asked for, so "there is more" is a fact rather than a
    // guess, and no list is ever unbounded.
    const rows: BranchRow[] = await tx.branch.findMany({
      where: {
        tenantId: tenantParam(scope),
        ...(after === null ? {} : { code: { gt: after } }),
      },
      orderBy: { code: 'asc' },
      take: size + 1,
    });
    const page = paginate(rows, size, (row) => row.code);
    return {
      items: page.items.map(branchToDomain),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  });
}

export interface NewBranch {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
}

export async function createBranch(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  input: NewBranch,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<AdminBranch> {
  const tenant = tenantParam(scope);
  const id = nextId();
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    // `ON CONFLICT DO NOTHING` rather than a preflight read: two administrators
    // creating the same code at once would both find it free.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "branches" ("id","tenantId","code","nameAr","nameEn","isActive","createdAt","updatedAt")
      VALUES (${id}::uuid, ${tenant}::uuid, ${input.code}, ${input.nameAr}, ${input.nameEn},
              true, ${at}, ${at})
      ON CONFLICT ("tenantId","code") DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 0) throw new MerchantAdminRefusedError('code-taken');

    await appendAudit(tx, tenant, actor, 'branch.created', 'branch', id, { code: input.code }, at);

    const row = await tx.branch.findFirst({ where: { id, tenantId: tenant } });
    if (row === null) throw new DatabaseError('The branch just created could not be read back.');
    return branchToDomain(row);
  });
}

export interface BranchPatch {
  readonly nameAr?: string | undefined;
  readonly nameEn?: string | null | undefined;
}

export async function updateBranch(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  branchId: string,
  patch: BranchPatch,
  clock: () => Date = () => new Date(),
): Promise<AdminBranch> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    // The tenant filter is what makes another merchant's branch id answer
    // `unknown-branch` rather than being written to. RLS refuses it as well;
    // neither alone is the boundary.
    const changed = await tx.branch.updateMany({
      where: { id: branchId, tenantId: tenant },
      data: {
        ...(patch.nameAr === undefined ? {} : { nameAr: patch.nameAr }),
        ...(patch.nameEn === undefined ? {} : { nameEn: patch.nameEn }),
        updatedAt: at,
      },
    });
    if (changed.count !== 1) throw new MerchantAdminRefusedError('unknown-branch');

    await appendAudit(
      tx,
      tenant,
      actor,
      'branch.updated',
      'branch',
      branchId,
      {
        fields: Object.keys(patch).sort().join(','),
      },
      at,
    );

    const row = await tx.branch.findFirst({ where: { id: branchId, tenantId: tenant } });
    if (row === null) throw new DatabaseError('The branch just updated could not be read back.');
    return branchToDomain(row);
  });
}

/**
 * Turn a branch on or off, refusing while a drawer in it is still open.
 *
 * Deactivating is not deleting and it rewrites nothing: every sale, shift and
 * invoice already recorded against the branch is untouched, and this strike
 * has no hard delete at all. What it must not do is strand an open drawer —
 * a till whose branch has gone inactive is a shift nobody can reason about, so
 * the request fails closed and the merchant closes the shift first.
 */
export async function setBranchActive(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  branchId: string,
  isActive: boolean,
  clock: () => Date = () => new Date(),
): Promise<AdminBranch> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    // The branch row, first and for the whole transaction. `ShiftRepository.open`
    // takes the same row before it takes a terminal, so an opening either
    // committed before this read — and is counted below — or waits behind this
    // transaction and then finds the branch stood down. That is what closes the
    // window between "no open shift" and "deactivated".
    await lockBranch(tx, tenant, branchId);
    const existing = await tx.branch.findFirst({ where: { id: branchId, tenantId: tenant } });
    if (existing === null) throw new MerchantAdminRefusedError('unknown-branch');

    if (!isActive) {
      // Every till in the branch, not just one: the branch lock covers them all
      // because openings queue on it whichever terminal they name.
      const open = await tx.shift.count({
        where: { tenantId: tenant, branchId, status: 'open' },
      });
      if (open > 0) throw new MerchantAdminRefusedError('branch-in-use');
    }

    await tx.branch.updateMany({
      where: { id: branchId, tenantId: tenant },
      data: { isActive, updatedAt: at },
    });

    await appendAudit(
      tx,
      tenant,
      actor,
      activationEvent('branch', isActive),
      'branch',
      branchId,
      { code: existing.code },
      at,
    );

    const row = await tx.branch.findFirst({ where: { id: branchId, tenantId: tenant } });
    if (row === null) throw new DatabaseError('The branch just changed could not be read back.');
    return branchToDomain(row);
  });
}

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

export interface AdminTerminal {
  readonly id: string;
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly lastSeenAt: string | null;
}

interface TerminalRow {
  id: string;
  branchId: string;
  code: string;
  label: string;
  isActive: boolean;
  lastSeenAt: Date | null;
}

function terminalToDomain(row: TerminalRow): AdminTerminal {
  return {
    id: row.id,
    branchId: row.branchId,
    code: row.code,
    label: row.label,
    isActive: row.isActive,
    lastSeenAt: isoOrNull(row.lastSeenAt),
  };
}

export async function listTerminals(
  prisma: PrismaClient,
  scope: TenantScope,
  limit: number,
  branchId: string | null = null,
  cursor: string | null = null,
): Promise<AdminPage<AdminTerminal>> {
  const size = pageSize(limit);
  const after = decodeCursor(cursor);
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const rows: TerminalRow[] = await tx.terminal.findMany({
      where: {
        tenantId: tenant,
        ...(branchId === null ? {} : { branchId }),
        ...(after === null ? {} : { code: { gt: after } }),
      },
      orderBy: { code: 'asc' },
      take: size + 1,
    });
    const page = paginate(rows, size, (row) => row.code);
    return {
      items: page.items.map(terminalToDomain),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  });
}

export interface NewTerminal {
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
}

/**
 * Register a till under a branch of this tenant.
 *
 * The branch is proved to be this tenant's inside the transaction. The
 * composite foreign key `(tenantId, branchId)` would refuse a foreign branch
 * anyway — that is ADR-0004's tenant-consistency key doing its job — but a
 * foreign-key violation surfaces as a database error, and the caller deserves
 * `unknown-branch`, which is also what a branch that simply does not exist
 * gets. A merchant administrator learns nothing about another merchant either
 * way.
 */
export async function createTerminal(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  input: NewTerminal,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<AdminTerminal> {
  const tenant = tenantParam(scope);
  const id = nextId();
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    // Held, not merely read: a branch deactivation running at the same moment
    // must not be able to commit between this check and the insert, or the
    // merchant ends up with a live till under a stood-down branch.
    const branch = await lockBranch(tx, tenant, input.branchId);
    // A till on a branch that is not trading is a till nobody can open a shift
    // on. Its own refusal, because "in use" would claim an open drawer exists.
    if (!branch.isActive) throw new MerchantAdminRefusedError('branch-inactive');

    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "terminals"
        ("id","tenantId","branchId","code","label","isActive","createdAt","updatedAt")
      VALUES (${id}::uuid, ${tenant}::uuid, ${input.branchId}::uuid, ${input.code},
              ${input.label}, true, ${at}, ${at})
      ON CONFLICT ("tenantId","code") DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 0) throw new MerchantAdminRefusedError('code-taken');

    await appendAudit(
      tx,
      tenant,
      actor,
      'terminal.created',
      'terminal',
      id,
      {
        code: input.code,
        branchId: input.branchId,
      },
      at,
    );

    const row = await tx.terminal.findFirst({ where: { id, tenantId: tenant } });
    if (row === null) throw new DatabaseError('The till just created could not be read back.');
    return terminalToDomain(row);
  });
}

export interface TerminalPatch {
  readonly label?: string | undefined;
}

export async function updateTerminal(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  terminalId: string,
  patch: TerminalPatch,
  clock: () => Date = () => new Date(),
): Promise<AdminTerminal> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    const changed = await tx.terminal.updateMany({
      where: { id: terminalId, tenantId: tenant },
      data: {
        ...(patch.label === undefined ? {} : { label: patch.label }),
        updatedAt: at,
      },
    });
    if (changed.count !== 1) throw new MerchantAdminRefusedError('unknown-terminal');

    await appendAudit(
      tx,
      tenant,
      actor,
      'terminal.updated',
      'terminal',
      terminalId,
      {
        fields: Object.keys(patch).sort().join(','),
      },
      at,
    );

    const row = await tx.terminal.findFirst({ where: { id: terminalId, tenantId: tenant } });
    if (row === null) throw new DatabaseError('The till just updated could not be read back.');
    return terminalToDomain(row);
  });
}

/** Same rule as a branch: a till with an open drawer is not deactivated. */
export async function setTerminalActive(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  terminalId: string,
  isActive: boolean,
  clock: () => Date = () => new Date(),
): Promise<AdminTerminal> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    // The terminal is read once, unlocked, only to learn which branch it is in
    // — the lock order is branches before terminals, so the branch has to be
    // known before anything is held.
    const addressed = await tx.terminal.findFirst({
      where: { id: terminalId, tenantId: tenant },
      select: { branchId: true },
    });
    if (addressed === null) throw new MerchantAdminRefusedError('unknown-terminal');

    const branch = await lockBranch(tx, tenant, addressed.branchId);
    const existing = await lockTerminal(tx, tenant, terminalId);
    // Re-read under the lock: the branch could have moved between the two.
    if (existing.branchId !== branch.id) throw new MerchantAdminRefusedError('unknown-terminal');

    // Switching a till on under a stood-down branch would produce exactly the
    // state `ShiftRepository.open` now refuses, and would look to the merchant
    // like a till that works.
    if (isActive && !branch.isActive) throw new MerchantAdminRefusedError('branch-inactive');

    if (!isActive) {
      const open = await tx.shift.count({
        where: { tenantId: tenant, terminalId, status: 'open' },
      });
      if (open > 0) throw new MerchantAdminRefusedError('branch-in-use');
    }

    await tx.terminal.updateMany({
      where: { id: terminalId, tenantId: tenant },
      data: { isActive, updatedAt: at },
    });

    await appendAudit(
      tx,
      tenant,
      actor,
      activationEvent('terminal', isActive),
      'terminal',
      terminalId,
      { code: existing.code },
      at,
    );

    const row = await tx.terminal.findFirst({ where: { id: terminalId, tenantId: tenant } });
    if (row === null) throw new DatabaseError('The till just changed could not be read back.');
    return terminalToDomain(row);
  });
}

// ---------------------------------------------------------------------------
// Members: users, memberships and roles
// ---------------------------------------------------------------------------

/**
 * A person in this merchant, as an administrator may see them.
 *
 * Deliberately absent: `passwordHash`, every session token hash, the failed
 * login counter and the lockout time. The first two are credential material
 * and this shape is the reason there is no path from an administration screen
 * to them; the last two are security telemetry that belongs to whoever
 * responds to an incident, not to a member list.
 */
export interface AdminMember {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly userActive: boolean;
  /** Null when the user exists but has never been admitted to this tenant. */
  readonly membershipStatus: string | null;
  readonly defaultBranchId: string | null;
  /** True when the account has a credential at all. Never the credential. */
  readonly hasCredential: boolean;
  readonly roleIds: readonly string[];
  readonly lastLoginAt: string | null;
}

interface MemberRow {
  id: string;
  email: string;
  displayName: string;
  isActive: boolean;
  passwordHash: string | null;
  lastLoginAt: Date | null;
  memberships: { status: string; defaultBranchId: string | null }[];
  roles: { roleId: string }[];
}

function memberToDomain(row: MemberRow): AdminMember {
  const membership = row.memberships[0];
  return {
    userId: row.id,
    email: row.email,
    displayName: row.displayName,
    userActive: row.isActive,
    membershipStatus: membership?.status ?? null,
    defaultBranchId: membership?.defaultBranchId ?? null,
    hasCredential: row.passwordHash !== null,
    roleIds: row.roles.map((role) => role.roleId),
    lastLoginAt: isoOrNull(row.lastLoginAt),
  };
}

const MEMBER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  isActive: true,
  passwordHash: true,
  lastLoginAt: true,
  memberships: { select: { status: true, defaultBranchId: true } },
  roles: { select: { roleId: true } },
} as const;

export async function listMembers(
  prisma: PrismaClient,
  scope: TenantScope,
  limit: number,
  cursor: string | null = null,
): Promise<AdminPage<AdminMember>> {
  const size = pageSize(limit);
  const after = decodeCursor(cursor);
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const rows = await tx.user.findMany({
      where: {
        tenantId: tenant,
        ...(after === null ? {} : { email: { gt: after } }),
      },
      orderBy: { email: 'asc' },
      take: size + 1,
      select: MEMBER_SELECT,
    });
    const page = paginate(rows, size, (row) => row.email);
    return {
      items: page.items.map(memberToDomain),
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    };
  });
}

async function readMember(
  tx: TransactionClient,
  tenant: string,
  userId: string,
): Promise<AdminMember> {
  const row = await tx.user.findFirst({
    where: { id: userId, tenantId: tenant },
    select: MEMBER_SELECT,
  });
  if (row === null) throw new MerchantAdminRefusedError('unknown-member');
  return memberToDomain(row);
}

export interface NewMember {
  /** Already normalised by the caller through the domain's `normalizeEmail`. */
  readonly email: string;
  readonly displayName: string;
  readonly defaultBranchId: string | null;
}

/**
 * Create a person in this merchant, with no credential.
 *
 * This is the whole of what Korvi can do honestly today. The account exists,
 * an administrator can place it in a branch and give it roles, and it cannot
 * sign in: `passwordHash` is null and the login path refuses a null credential
 * outright rather than comparing against nothing.
 *
 * There is deliberately no invitation. Korvi has no mail transport, no
 * single-use credential token and no password-reset flow, and inventing an
 * `invitedAt` column or an "invitation sent" response would be a claim that
 * something left the building. Establishing the credential is the deferred
 * boundary named in ADR-0019, not a thing this function pretends to do.
 */
export async function createMember(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  input: NewMember,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<AdminMember> {
  const tenant = tenantParam(scope);
  const userId = nextId();
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();

    if (input.defaultBranchId !== null) {
      const branch = await tx.branch.findFirst({
        where: { id: input.defaultBranchId, tenantId: tenant },
      });
      if (branch === null) throw new MerchantAdminRefusedError('unknown-branch');
    }

    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "users" ("id","tenantId","email","displayName","isActive","createdAt","updatedAt")
      VALUES (${userId}::uuid, ${tenant}::uuid, ${input.email}, ${input.displayName},
              true, ${at}, ${at})
      ON CONFLICT ("tenantId","email") DO NOTHING
      RETURNING "id"`;
    if (inserted.length === 0) throw new MerchantAdminRefusedError('email-taken');

    await tx.tenantMembership.create({
      data: {
        id: nextId(),
        tenantId: tenant,
        userId,
        defaultBranchId: input.defaultBranchId,
        status: 'active',
        updatedAt: at,
      },
    });

    await appendAudit(
      tx,
      tenant,
      actor,
      'member.created',
      'user',
      userId,
      {
        // The address is the merchant's own record of who this is, and an
        // administrator who can read the member list can already read it.
        email: input.email,
        hasCredential: false,
      },
      at,
    );

    return readMember(tx, tenant, userId);
  });
}

export interface MemberPatch {
  readonly displayName?: string | undefined;
  /** Undefined leaves it alone; null clears it. Both are meaningful. */
  readonly defaultBranchId?: string | null | undefined;
}

export async function updateMember(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  patch: MemberPatch,
  clock: () => Date = () => new Date(),
): Promise<AdminMember> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();

    if (patch.defaultBranchId !== undefined && patch.defaultBranchId !== null) {
      const branch = await tx.branch.findFirst({
        where: { id: patch.defaultBranchId, tenantId: tenant },
      });
      if (branch === null) throw new MerchantAdminRefusedError('unknown-branch');
    }

    if (patch.displayName !== undefined) {
      const changed = await tx.user.updateMany({
        where: { id: userId, tenantId: tenant },
        data: { displayName: patch.displayName, updatedAt: at },
      });
      if (changed.count !== 1) throw new MerchantAdminRefusedError('unknown-member');
    }

    if (patch.defaultBranchId !== undefined) {
      const changed = await tx.tenantMembership.updateMany({
        where: { userId, tenantId: tenant },
        data: { defaultBranchId: patch.defaultBranchId, updatedAt: at },
      });
      if (changed.count !== 1) throw new MerchantAdminRefusedError('unknown-member');
    }

    const member = await readMember(tx, tenant, userId);
    await appendAudit(
      tx,
      tenant,
      actor,
      'member.updated',
      'user',
      userId,
      {
        fields: Object.keys(patch).sort().join(','),
      },
      at,
    );
    return member;
  });
}

export interface AccessChange {
  readonly member: AdminMember;
  /** Sessions this call stopped. Zero when the change did not remove access. */
  readonly revokedSessions: number;
}

/**
 * Enable or disable the account itself.
 *
 * Disabling is a security event, so three things happen in one transaction:
 * the flag moves, every live session for that user is revoked, and the audit
 * row is written. Session resolution would already refuse an inactive user on
 * the next request — it reads `isActive` from the row rather than from the
 * token — but revoking is the durable act, and it is what makes "the session
 * is gone" true rather than "the next request will notice".
 *
 * Enabling revokes nothing and resurrects nothing. `revokedAt` is never
 * cleared, so a session stopped by a deactivation stays stopped and the person
 * signs in again.
 */
export async function setMemberUserActive(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  isActive: boolean,
  clock: () => Date = () => new Date(),
): Promise<AccessChange> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    // Serialization point for every change that can reduce administrative
    // authority. Taken before anything is read, so two operators removing two
    // different administrators cannot both measure a healthy outcome.
    await lockTenant(tx, tenant);

    const changed = await tx.user.updateMany({
      where: { id: userId, tenantId: tenant },
      data: { isActive, updatedAt: at },
    });
    if (changed.count !== 1) throw new MerchantAdminRefusedError('unknown-member');

    const revokedSessions = isActive ? 0 : await revokeSessionsFor(tx, tenant, userId, at);

    if (!isActive) await assertStillAdministrable(tx, tenant);

    await appendAudit(
      tx,
      tenant,
      actor,
      isActive ? 'member.user-activated' : 'member.user-deactivated',
      'user',
      userId,
      { revokedSessions },
      at,
    );

    return { member: await readMember(tx, tenant, userId), revokedSessions };
  });
}

/**
 * Admit a person to this tenant, or stop admitting them.
 *
 * The same three-in-one-transaction rule as the account flag, and for the same
 * reason: session resolution refuses a non-active membership, and a revoked
 * session is the durable form of that refusal.
 */
export async function setMemberMembershipActive(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  isActive: boolean,
  clock: () => Date = () => new Date(),
): Promise<AccessChange> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    await lockTenant(tx, tenant);

    const changed = await tx.tenantMembership.updateMany({
      where: { userId, tenantId: tenant },
      data: { status: isActive ? 'active' : 'inactive', updatedAt: at },
    });
    if (changed.count !== 1) throw new MerchantAdminRefusedError('unknown-member');

    const revokedSessions = isActive ? 0 : await revokeSessionsFor(tx, tenant, userId, at);

    if (!isActive) await assertStillAdministrable(tx, tenant);

    await appendAudit(
      tx,
      tenant,
      actor,
      isActive ? 'member.membership-activated' : 'member.membership-deactivated',
      'tenant_membership',
      userId,
      { revokedSessions },
      at,
    );

    return { member: await readMember(tx, tenant, userId), revokedSessions };
  });
}

// ---------------------------------------------------------------------------
// Role assignment
// ---------------------------------------------------------------------------

export interface AdminRole {
  readonly id: string;
  readonly key: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isSystem: boolean;
  readonly maxDiscountBasisPoints: number;
  readonly permissions: readonly string[];
}

/**
 * The roles this tenant has, with what each actually grants.
 *
 * The permissions are read from `role_permissions` rather than from the
 * domain's default table, because a role is what the database says it grants.
 * An administrator choosing between roles is choosing between capabilities,
 * and showing them a hard-coded list would be showing them the wrong one the
 * moment a merchant's roles diverge from the defaults.
 */
export async function listAssignableRoles(
  prisma: PrismaClient,
  scope: TenantScope,
): Promise<readonly AdminRole[]> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const roles = await tx.role.findMany({
      where: { tenantId: tenant },
      orderBy: { key: 'asc' },
      // Bounded rather than paged: the role set is four rows by architecture
      // and custom-role CRUD is deferred, so a cursor would be ceremony. The
      // ceiling is here so the query cannot become unbounded by accident when
      // that changes (ADR-0019).
      take: MAX_ASSIGNABLE_ROLES,
      select: {
        id: true,
        key: true,
        nameAr: true,
        nameEn: true,
        isSystem: true,
        maxDiscountBasisPoints: true,
        permissions: { select: { permissionKey: true }, orderBy: { permissionKey: 'asc' } },
      },
    });
    return roles.map((role) => ({
      id: role.id,
      key: role.key,
      nameAr: role.nameAr,
      nameEn: role.nameEn,
      isSystem: role.isSystem,
      maxDiscountBasisPoints: role.maxDiscountBasisPoints,
      permissions: role.permissions.map((binding) => binding.permissionKey),
    }));
  });
}

export interface RoleAssignmentResult {
  readonly member: AdminMember;
  /** False when the assignment was already in place. Not an error. */
  readonly changed: boolean;
}

/**
 * Give a person one of this tenant's roles.
 *
 * Both ends are proved to belong to this tenant before anything is written,
 * and the composite `(tenantId, roleId)` and `(tenantId, userId)` foreign keys
 * would refuse a mismatch anyway. Raw permissions are not accepted here in any
 * form: a role is the only unit of grant, which is what keeps "what can this
 * person do" answerable by looking at one table.
 *
 * Idempotent by the unique index rather than by a preflight read, so two
 * identical requests arriving together settle to one row and one audit event.
 */
export async function assignRoleToMember(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  roleId: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<RoleAssignmentResult> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();

    const user = await tx.user.findFirst({ where: { id: userId, tenantId: tenant } });
    if (user === null) throw new MerchantAdminRefusedError('unknown-member');
    const role = await tx.role.findFirst({ where: { id: roleId, tenantId: tenant } });
    if (role === null) throw new MerchantAdminRefusedError('unknown-role');

    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "user_roles" ("id","tenantId","userId","roleId")
      VALUES (${nextId()}::uuid, ${tenant}::uuid, ${userId}::uuid, ${roleId}::uuid)
      ON CONFLICT ("tenantId","userId","roleId") DO NOTHING
      RETURNING "id"`;
    const changed = inserted.length === 1;

    // Only a change is an event. A replay that wrote nothing must not leave an
    // audit row saying a grant happened today.
    if (changed) {
      await appendAudit(
        tx,
        tenant,
        actor,
        'member.role-assigned',
        'user_role',
        userId,
        {
          roleId,
          roleKey: role.key,
        },
        at,
      );
    }

    return { member: await readMember(tx, tenant, userId), changed };
  });
}

/**
 * Take a role away.
 *
 * The tenant row is locked first, because this is the other way a merchant can
 * lock itself out: removing the last role that grants `users.manage` from the
 * last person who holds it. The check runs on the post-state, so it catches
 * the case where two operators remove two different people's authority at the
 * same moment.
 *
 * Sessions are not revoked. They do not need to be: authorization is read from
 * `user_roles` on every request rather than carried in the token, so the very
 * next request from an already-issued session no longer has the permission.
 * Signing somebody out because their discount ceiling changed would be a worse
 * answer to a smaller problem (ADR-0019).
 */
export async function removeRoleFromMember(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: AdminActor,
  userId: string,
  roleId: string,
  clock: () => Date = () => new Date(),
): Promise<RoleAssignmentResult> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const at = clock();
    await lockTenant(tx, tenant);

    const user = await tx.user.findFirst({ where: { id: userId, tenantId: tenant } });
    if (user === null) throw new MerchantAdminRefusedError('unknown-member');
    const role = await tx.role.findFirst({ where: { id: roleId, tenantId: tenant } });
    if (role === null) throw new MerchantAdminRefusedError('unknown-role');

    const removed = await tx.userRole.deleteMany({ where: { tenantId: tenant, userId, roleId } });
    const changed = removed.count > 0;

    if (changed) {
      await assertStillAdministrable(tx, tenant);
      await appendAudit(
        tx,
        tenant,
        actor,
        'member.role-unassigned',
        'user_role',
        userId,
        {
          roleId,
          roleKey: role.key,
        },
        at,
      );
    }

    return { member: await readMember(tx, tenant, userId), changed };
  });
}
