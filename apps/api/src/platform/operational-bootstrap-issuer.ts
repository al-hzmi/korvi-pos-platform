import { createPrismaClient } from '@korvi/database';
import {
  provisionTenantOperations,
  type PlatformOperationalBootstrapRequest,
  type PlatformOperationalBootstrapResult,
} from '@korvi/database/platform-operational-bootstrap';
import type { PrismaClient } from '@korvi/database';
import type { PlatformActor } from './service.js';

export type PlatformOperationalBootstrapInput = Omit<
  PlatformOperationalBootstrapRequest,
  'tenantId' | 'controlPlaneActorRef'
>;

export class PlatformOperationalBootstrapUnavailableError extends Error {
  public override readonly name = 'PlatformOperationalBootstrapUnavailableError';

  public constructor() {
    super('Platform operational bootstrap authority is not configured.');
  }
}

let prisma: PrismaClient | null = null;

function database(): PrismaClient {
  if (prisma !== null) return prisma;
  const url = process.env['DATABASE_URL'];
  if (url === undefined) throw new PlatformOperationalBootstrapUnavailableError();
  prisma = createPrismaClient(url);
  return prisma;
}

/**
 * Bootstrap the initial branch/register pair from authenticated Platform Admin.
 *
 * The platform actor comes from the signed platform session. The target tenant
 * comes from the route path. Neither may be supplied as authority fields in the
 * JSON request body.
 */
export async function issuePlatformOperationalBootstrap(
  actor: PlatformActor,
  tenantId: string,
  input: PlatformOperationalBootstrapInput,
): Promise<PlatformOperationalBootstrapResult> {
  return provisionTenantOperations(database(), {
    tenantId,
    ...input,
    controlPlaneActorRef: actor.controlPlaneActorRef,
  });
}
