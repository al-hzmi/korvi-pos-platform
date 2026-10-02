import { createPrismaClient, issueOwnerBootstrapInvitation } from '@korvi/database';
import type { IssuedOwnerBootstrap, PrismaClient } from '@korvi/database';
import type { PlatformActor } from './service.js';

export interface PlatformOwnerBootstrapInvitation {
  readonly operationId: string;
  readonly email: string;
  readonly displayName: string;
}

export class PlatformOwnerBootstrapUnavailableError extends Error {
  public override readonly name = 'PlatformOwnerBootstrapUnavailableError';

  public constructor() {
    super('Owner bootstrap authority is not configured.');
  }
}

let prisma: PrismaClient | null = null;

function database(): PrismaClient {
  if (prisma !== null) return prisma;
  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new PlatformOwnerBootstrapUnavailableError();
  prisma = createPrismaClient(url);
  return prisma;
}

/**
 * Issue the one-shot owner capability from the SaaS control plane.
 *
 * This authority is intentionally separate from Merchant Admin. It reads only
 * deployment configuration, fails closed if either required secret is absent,
 * and delegates all idempotency/RLS/audit/token rules to the reviewed database
 * authority from ADR-0021. No raw capability or signing key is persisted here.
 */
export async function issuePlatformOwnerBootstrap(
  actor: PlatformActor,
  tenantId: string,
  input: PlatformOwnerBootstrapInvitation,
): Promise<IssuedOwnerBootstrap> {
  const signingKey = process.env['BOOTSTRAP_SIGNING_KEY'];
  if (signingKey === undefined) throw new PlatformOwnerBootstrapUnavailableError();

  return issueOwnerBootstrapInvitation(database(), signingKey, {
    tenantId,
    ...input,
    controlPlaneActorRef: actor.controlPlaneActorRef,
  });
}
