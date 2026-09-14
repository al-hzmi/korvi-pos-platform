import { TENANT_LIFECYCLE_STATES, tenantId as asTenantId } from '@korvi/domain';
import { readCommercialAccount } from '../commercial/plan-entitlements.js';
import { withControlPlane, withTenant } from '../tenant-context.js';
import { oneOf } from '../repositories/mapping.js';
import type {
  CommercialAccountSnapshot,
  TenantLifecycleState,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

export const MAX_PLATFORM_TENANT_PAGE = 100;
export const MAX_PLATFORM_AUDIT_PAGE = 100;

export interface PlatformTenantListQuery {
  readonly controlPlaneActorRef: string;
  readonly search?: string;
  readonly status?: TenantLifecycleState;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface PlatformTenantSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly vatNumber: string | null;
  readonly status: TenantLifecycleState;
  readonly lifecycleProvenance: string;
  readonly activatedAt: string | null;
  readonly suspendedAt: string | null;
  readonly suspensionReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlatformTenantPage {
  readonly items: readonly PlatformTenantSummary[];
  readonly nextCursor: string | null;
}

export interface PlatformOwnerSummary {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
  readonly isActive: boolean;
  readonly lastLoginAt: string | null;
}

export interface PlatformTenantOperations {
  readonly branches: { readonly total: number; readonly active: number };
  readonly terminals: { readonly total: number; readonly active: number };
  readonly users: { readonly total: number; readonly active: number };
  readonly owner: PlatformOwnerSummary | null;
  readonly lastActivityAt: string | null;
  readonly zatca: {
    readonly latestProvisioningState: string | null;
    readonly latestProvisioningAt: string | null;
  };
}

export interface PlatformTenantDetail {
  readonly tenant: PlatformTenantSummary;
  readonly commercial: CommercialAccountSnapshot | null;
  readonly operations: PlatformTenantOperations;
}

export interface PlatformAuditEntry {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly branchId: string | null;
  readonly terminalId: string | null;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly metadata: unknown;
  readonly occurredAt: string;
}

function boundedLimit(value: number | undefined, max: number): number {
  if (value === undefined) return Math.min(50, max);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new RangeError(`limit must be an integer from 1 to ${String(max)}`);
  }
  return value;
}

function normalizeSearch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize('NFKC').trim();
  if (normalized === '') return undefined;
  if (normalized.length > 120) throw new RangeError('search must be at most 120 characters');
  return normalized;
}

function mapTenant(row: {
  id: string;
  slug: string;
  name: string;
  vatNumber: string | null;
  status: string;
  lifecycleProvenance: string;
  activatedAt: Date | null;
  suspendedAt: Date | null;
  suspensionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}): PlatformTenantSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    vatNumber: row.vatNumber,
    status: oneOf(TENANT_LIFECYCLE_STATES, row.status, 'tenants.status'),
    lifecycleProvenance: row.lifecycleProvenance,
    activatedAt: row.activatedAt?.toISOString() ?? null,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    suspensionReason: row.suspensionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listPlatformTenants(
  prisma: PrismaClient,
  query: PlatformTenantListQuery,
): Promise<PlatformTenantPage> {
  const limit = boundedLimit(query.limit, MAX_PLATFORM_TENANT_PAGE);
  const search = normalizeSearch(query.search);

  return withControlPlane(prisma, query.controlPlaneActorRef, async (tx) => {
    const rows = await tx.tenant.findMany({
      where: {
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(search === undefined
          ? {}
          : {
              OR: [
                { name: { contains: search, mode: 'insensitive' as const } },
                { slug: { contains: search, mode: 'insensitive' as const } },
                { vatNumber: { contains: search } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: {
        id: true,
        slug: true,
        name: true,
        vatNumber: true,
        status: true,
        lifecycleProvenance: true,
        activatedAt: true,
        suspendedAt: true,
        suspensionReason: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return {
      items: page.map(mapTenant),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  });
}

export async function readPlatformTenant(
  prisma: PrismaClient,
  controlPlaneActorRef: string,
  tenant: string,
): Promise<PlatformTenantSummary | null> {
  return withControlPlane(prisma, controlPlaneActorRef, async (tx) => {
    const row = await tx.tenant.findUnique({
      where: { id: tenant },
      select: {
        id: true,
        slug: true,
        name: true,
        vatNumber: true,
        status: true,
        lifecycleProvenance: true,
        activatedAt: true,
        suspendedAt: true,
        suspensionReason: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return row === null ? null : mapTenant(row);
  });
}

async function readOperations(prisma: PrismaClient, tenant: string): Promise<PlatformTenantOperations> {
  return withTenant(prisma, tenant, async (tx) => {
    const [
      branchTotal,
      branchActive,
      terminalTotal,
      terminalActive,
      userTotal,
      userActive,
      ownerRows,
      latestAudit,
      latestTerminal,
      latestLogin,
      latestZatca,
    ] = await Promise.all([
      tx.branch.count({ where: { tenantId: tenant } }),
      tx.branch.count({ where: { tenantId: tenant, isActive: true } }),
      tx.terminal.count({ where: { tenantId: tenant } }),
      tx.terminal.count({ where: { tenantId: tenant, isActive: true } }),
      tx.user.count({ where: { tenantId: tenant } }),
      tx.user.count({ where: { tenantId: tenant, isActive: true } }),
      tx.$queryRaw<
        { id: string; displayName: string; email: string; isActive: boolean; lastLoginAt: Date | null }[]
      >`
        SELECT u."id", u."displayName", u."email", u."isActive", u."lastLoginAt"
          FROM "users" u
          JOIN "user_roles" ur
            ON ur."tenantId" = u."tenantId" AND ur."userId" = u."id"
          JOIN "roles" r
            ON r."tenantId" = ur."tenantId" AND r."id" = ur."roleId"
         WHERE u."tenantId" = ${tenant}::uuid AND r."key" = 'owner'
         ORDER BY u."createdAt" ASC
         LIMIT 1`,
      tx.auditEvent.findFirst({
        where: { tenantId: tenant },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
      tx.terminal.findFirst({
        where: { tenantId: tenant, lastSeenAt: { not: null } },
        orderBy: { lastSeenAt: 'desc' },
        select: { lastSeenAt: true },
      }),
      tx.user.findFirst({
        where: { tenantId: tenant, lastLoginAt: { not: null } },
        orderBy: { lastLoginAt: 'desc' },
        select: { lastLoginAt: true },
      }),
      tx.zatcaCsidProvisioningAttempt.findFirst({
        where: { tenantId: tenant },
        orderBy: { updatedAt: 'desc' },
        select: { state: true, updatedAt: true },
      }),
    ]);

    const owner = ownerRows[0];
    const activity = [latestAudit?.occurredAt, latestTerminal?.lastSeenAt, latestLogin?.lastLoginAt]
      .filter((value): value is Date => value instanceof Date)
      .sort((a, b) => b.getTime() - a.getTime())[0];

    return {
      branches: { total: branchTotal, active: branchActive },
      terminals: { total: terminalTotal, active: terminalActive },
      users: { total: userTotal, active: userActive },
      owner:
        owner === undefined
          ? null
          : {
              id: owner.id,
              displayName: owner.displayName,
              email: owner.email,
              isActive: owner.isActive,
              lastLoginAt: owner.lastLoginAt?.toISOString() ?? null,
            },
      lastActivityAt: activity?.toISOString() ?? null,
      zatca: {
        latestProvisioningState: latestZatca?.state ?? null,
        latestProvisioningAt: latestZatca?.updatedAt.toISOString() ?? null,
      },
    };
  });
}

export async function readPlatformTenantDetail(
  prisma: PrismaClient,
  controlPlaneActorRef: string,
  tenant: string,
): Promise<PlatformTenantDetail | null> {
  const identity = await readPlatformTenant(prisma, controlPlaneActorRef, tenant);
  if (identity === null) return null;
  const [commercial, operations] = await Promise.all([
    readCommercialAccount(prisma, { tenantId: asTenantId(tenant) }),
    readOperations(prisma, tenant),
  ]);
  return { tenant: identity, commercial, operations };
}

export async function listPlatformTenantAudit(
  prisma: PrismaClient,
  tenant: string,
  limit?: number,
): Promise<readonly PlatformAuditEntry[]> {
  const take = boundedLimit(limit, MAX_PLATFORM_AUDIT_PAGE);
  return withTenant(prisma, tenant, async (tx) => {
    const rows = await tx.auditEvent.findMany({
      where: { tenantId: tenant },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take,
      select: {
        id: true,
        actorUserId: true,
        branchId: true,
        terminalId: true,
        eventType: true,
        entityType: true,
        entityId: true,
        metadata: true,
        occurredAt: true,
      },
    });
    return rows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() }));
  });
}
