import { createPlatformSupportNote, listPlatformSupportNotes } from '@korvi/database';
import type {
  PlatformSupportNoteCreateResult,
  PlatformSupportNotePage,
  PrismaClient,
} from '@korvi/database';

export interface PlatformSupportActor {
  readonly controlPlaneActorRef: string;
}

export interface PlatformSupportService {
  list(
    actor: PlatformSupportActor,
    tenantId: string,
    query?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<PlatformSupportNotePage>;
  create(
    actor: PlatformSupportActor,
    tenantId: string,
    input: { readonly operationId: string; readonly body: string },
  ): Promise<PlatformSupportNoteCreateResult>;
}

export function createPlatformSupportService(prisma: PrismaClient): PlatformSupportService {
  return {
    list(actor, tenantId, query = {}) {
      return listPlatformSupportNotes(prisma, {
        tenantId,
        controlPlaneActorRef: actor.controlPlaneActorRef,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: query.limit }),
      });
    },

    create(actor, tenantId, input) {
      return createPlatformSupportNote(prisma, {
        tenantId,
        operationId: input.operationId,
        body: input.body,
        controlPlaneActorRef: actor.controlPlaneActorRef,
      });
    },
  };
}
