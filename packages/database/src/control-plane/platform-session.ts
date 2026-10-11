import { withControlPlane } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

export interface PlatformAdminSessionRecord {
  readonly id: string;
  readonly actorRef: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface PlatformAdminSessionStore {
  create(input: {
    readonly id: string;
    readonly actorRef: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }): Promise<void>;
  isActive(input: {
    readonly id: string;
    readonly actorRef: string;
    readonly at: Date;
  }): Promise<boolean>;
  revoke(input: {
    readonly id: string;
    readonly actorRef: string;
    readonly at: Date;
  }): Promise<boolean>;
}

/**
 * Durable Platform Admin session authority.
 *
 * The signed cookie proves integrity; this store proves that the server still
 * recognizes the session as live. Keeping revocation in PostgreSQL means a
 * logout survives restarts and applies consistently across API instances.
 */
export function createPlatformAdminSessionStore(prisma: PrismaClient): PlatformAdminSessionStore {
  return {
    async create(input): Promise<void> {
      await withControlPlane(prisma, input.actorRef, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO "platform_admin_sessions"
            ("id","actorRef","createdAt","expiresAt","revokedAt")
          VALUES
            (${input.id}::uuid, ${input.actorRef}, ${input.createdAt}, ${input.expiresAt}, NULL)
        `;
      });
    },

    async isActive(input): Promise<boolean> {
      return withControlPlane(prisma, input.actorRef, async (tx) => {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id"
          FROM "platform_admin_sessions"
          WHERE "id" = ${input.id}::uuid
            AND "actorRef" = ${input.actorRef}
            AND "revokedAt" IS NULL
            AND "expiresAt" > ${input.at}
          LIMIT 1
        `;
        return rows.length === 1;
      });
    },

    async revoke(input): Promise<boolean> {
      return withControlPlane(prisma, input.actorRef, async (tx) => {
        const changed = await tx.$executeRaw`
          UPDATE "platform_admin_sessions"
          SET "revokedAt" = ${input.at}
          WHERE "id" = ${input.id}::uuid
            AND "actorRef" = ${input.actorRef}
            AND "revokedAt" IS NULL
            AND "expiresAt" > ${input.at}
        `;
        return changed === 1;
      });
    },
  };
}
