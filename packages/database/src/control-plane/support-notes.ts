import { createHash } from 'node:crypto';
import { newId, normalizeControlPlaneActor, normalizeControlPlaneOperation } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { withControlPlane } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

export const MAX_PLATFORM_SUPPORT_NOTE_LENGTH = 4000;
export const MAX_PLATFORM_SUPPORT_NOTE_PAGE = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PlatformSupportNoteRefusal =
  | 'unknown-tenant'
  | 'invalid-tenant'
  | 'invalid-note'
  | 'invalid-cursor'
  | 'invalid-limit'
  | 'idempotency-conflict';

export class PlatformSupportNoteRefusedError extends DatabaseError {
  public override readonly name = 'PlatformSupportNoteRefusedError';
  public readonly detail: PlatformSupportNoteRefusal;

  public constructor(detail: PlatformSupportNoteRefusal) {
    super(`Platform support note refused: ${detail}`);
    this.detail = detail;
  }
}

export interface PlatformSupportNote {
  readonly id: string;
  readonly tenantId: string;
  readonly operationId: string;
  readonly actorRef: string;
  readonly body: string;
  readonly createdAt: Date;
}

export interface PlatformSupportNotePage {
  readonly items: readonly PlatformSupportNote[];
  readonly nextCursor: string | null;
}

export interface PlatformSupportNoteCreateRequest {
  readonly tenantId: string;
  readonly operationId: string;
  readonly controlPlaneActorRef: string;
  readonly body: string;
}

export interface PlatformSupportNoteCreateResult {
  readonly note: PlatformSupportNote;
  readonly replayed: boolean;
}

interface StoredSupportNote extends PlatformSupportNote {
  readonly requestHash: string;
}

function tenantUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new PlatformSupportNoteRefusedError('invalid-tenant');
  return value.toLowerCase();
}

function noteBody(value: string): string {
  const normalized = value.normalize('NFKC').trim();
  if (
    normalized === '' ||
    normalized.includes('\u0000') ||
    Array.from(normalized).length > MAX_PLATFORM_SUPPORT_NOTE_LENGTH
  ) {
    throw new PlatformSupportNoteRefusedError('invalid-note');
  }
  return normalized;
}

function supportNoteHash(input: {
  readonly tenantId: string;
  readonly operationId: string;
  readonly actorRef: string;
  readonly body: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        tenantId: input.tenantId,
        operationId: input.operationId,
        actorRef: input.actorRef,
        body: input.body,
      }),
    )
    .digest('hex');
}

function publicNote(row: StoredSupportNote): PlatformSupportNote {
  return {
    id: row.id,
    tenantId: row.tenantId,
    operationId: row.operationId,
    actorRef: row.actorRef,
    body: row.body,
    createdAt: row.createdAt,
  };
}

export async function listPlatformSupportNotes(
  prisma: PrismaClient,
  input: {
    readonly tenantId: string;
    readonly controlPlaneActorRef: string;
    readonly cursor?: string;
    readonly limit?: number;
  },
): Promise<PlatformSupportNotePage> {
  const tenantId = tenantUuid(input.tenantId);
  const actorRef = normalizeControlPlaneActor(input.controlPlaneActorRef);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PLATFORM_SUPPORT_NOTE_PAGE) {
    throw new PlatformSupportNoteRefusedError('invalid-limit');
  }
  const cursor = input.cursor;
  if (cursor !== undefined && !UUID_PATTERN.test(cursor)) {
    throw new PlatformSupportNoteRefusedError('invalid-cursor');
  }

  return withControlPlane(prisma, actorRef, async (tx) => {
    const tenants = await tx.$queryRaw<{ readonly id: string }[]>`
      SELECT "id"
      FROM "tenants"
      WHERE "id" = ${tenantId}::uuid
      LIMIT 1
    `;
    if (tenants.length !== 1) throw new PlatformSupportNoteRefusedError('unknown-tenant');

    const take = limit + 1;
    const rows =
      cursor === undefined
        ? await tx.$queryRaw<StoredSupportNote[]>`
            SELECT "id", "tenantId", "operationId", "requestHash", "actorRef", "body", "createdAt"
            FROM "platform_support_notes"
            WHERE "tenantId" = ${tenantId}::uuid
            ORDER BY "id" DESC
            LIMIT ${take}
          `
        : await tx.$queryRaw<StoredSupportNote[]>`
            SELECT "id", "tenantId", "operationId", "requestHash", "actorRef", "body", "createdAt"
            FROM "platform_support_notes"
            WHERE "tenantId" = ${tenantId}::uuid
              AND "id" < ${cursor.toLowerCase()}::uuid
            ORDER BY "id" DESC
            LIMIT ${take}
          `;
    const visible = rows.slice(0, limit);
    return {
      items: visible.map(publicNote),
      nextCursor: rows.length > limit ? (visible.at(-1)?.id ?? null) : null,
    };
  });
}

export async function createPlatformSupportNote(
  prisma: PrismaClient,
  request: PlatformSupportNoteCreateRequest,
): Promise<PlatformSupportNoteCreateResult> {
  const tenantId = tenantUuid(request.tenantId);
  const actorRef = normalizeControlPlaneActor(request.controlPlaneActorRef);
  const operationId = normalizeControlPlaneOperation(request.operationId);
  const body = noteBody(request.body);
  const requestHash = supportNoteHash({ tenantId, operationId, actorRef, body });

  return withControlPlane(prisma, actorRef, async (tx) => {
    // Existence is established inside the same transaction that owns the
    // idempotency decision and INSERT. A separate preflight transaction would
    // leave a deletion race between "exists" and the foreign-key write.
    const tenants = await tx.$queryRaw<{ readonly id: string }[]>`
      SELECT "id"
      FROM "tenants"
      WHERE "id" = ${tenantId}::uuid
      LIMIT 1
    `;
    if (tenants.length !== 1) throw new PlatformSupportNoteRefusedError('unknown-tenant');

    const existing = await tx.$queryRaw<StoredSupportNote[]>`
      SELECT "id", "tenantId", "operationId", "requestHash", "actorRef", "body", "createdAt"
      FROM "platform_support_notes"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "operationId" = ${operationId}
      LIMIT 1
    `;
    if (existing[0] !== undefined) {
      if (existing[0].requestHash !== requestHash) {
        throw new PlatformSupportNoteRefusedError('idempotency-conflict');
      }
      return { note: publicNote(existing[0]), replayed: true };
    }

    const id = newId();
    await tx.$executeRaw`
      INSERT INTO "platform_support_notes"
        ("id", "tenantId", "operationId", "requestHash", "actorRef", "body")
      VALUES
        (${id}::uuid, ${tenantId}::uuid, ${operationId}, ${requestHash}, ${actorRef}, ${body})
      ON CONFLICT ("tenantId", "operationId") DO NOTHING
    `;

    const stored = await tx.$queryRaw<StoredSupportNote[]>`
      SELECT "id", "tenantId", "operationId", "requestHash", "actorRef", "body", "createdAt"
      FROM "platform_support_notes"
      WHERE "tenantId" = ${tenantId}::uuid
        AND "operationId" = ${operationId}
      LIMIT 1
    `;
    const note = stored[0];
    if (note === undefined)
      throw new DatabaseError('Platform support note insert produced no row.');
    if (note.requestHash !== requestHash) {
      throw new PlatformSupportNoteRefusedError('idempotency-conflict');
    }
    return { note: publicNote(note), replayed: note.id !== id };
  });
}
