import { withTenant } from '../tenant-context.js';
import { iso, tenantParam } from './mapping.js';
import type { AuditEventInput, AuditRepository, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

type Metadata = Readonly<Record<string, string | number | boolean | null>>;

interface AuditRow {
  id: string;
  actorUserId: string | null;
  branchId: string | null;
  terminalId: string | null;
  eventType: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  occurredAt: Date;
}

/**
 * Narrow the JSON column back to the shape the port promises.
 *
 * Anything that is not a flat object of primitives is dropped rather than
 * coerced. An audit row whose metadata has been written by some other tool is
 * still worth showing — the actor, the event and the time are the parts that
 * matter — and guessing at a nested structure would be worse than omitting it.
 */
function narrowMetadata(value: unknown): Metadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    ) {
      out[key] = entry;
    }
  }
  return out;
}

/**
 * Append-only. There is no update and no delete, here or in the schema —
 * an audit trail a caller can rewrite is not one.
 */
export function createAuditRepository(prisma: PrismaClient): AuditRepository {
  return {
    async append(scope: TenantScope, event: AuditEventInput): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        await tx.auditEvent.create({
          data: {
            id: event.id,
            tenantId: tenantParam(scope),
            actorUserId: event.actorUserId,
            branchId: event.branchId,
            terminalId: event.terminalId,
            eventType: event.eventType,
            entityType: event.entityType,
            entityId: event.entityId,
            // Omitted rather than set to null: a JSON column takes a database
            // NULL by absence, and Prisma reads an explicit null as the JSON
            // value `null`, which is a different thing.
            ...(event.metadata === null ? {} : { metadata: { ...event.metadata } }),
            occurredAt: new Date(event.occurredAt),
          },
        });
      });
    },

    async list(scope: TenantScope, limit: number): Promise<readonly AuditEventInput[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: AuditRow[] = await tx.auditEvent.findMany({
          where: { tenantId: tenantParam(scope) },
          orderBy: { occurredAt: 'desc' },
          take: limit,
        });
        return rows.map((row) => ({
          id: row.id,
          actorUserId: row.actorUserId,
          branchId: row.branchId,
          terminalId: row.terminalId,
          eventType: row.eventType,
          entityType: row.entityType,
          entityId: row.entityId,
          metadata: narrowMetadata(row.metadata),
          occurredAt: iso(row.occurredAt),
        }));
      });
    },
  };
}
