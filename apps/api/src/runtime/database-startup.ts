import { provisionPermissionCatalogue } from '@korvi/database';
import { verifyDeploymentDatabase } from '../staging/preflight.js';
import type { PrismaClient } from '@korvi/database';
import type { ApiConfig } from '../config.js';

export interface DatabaseStartupHooks {
  readonly verifyDeploymentDatabase: (prisma: PrismaClient) => Promise<void>;
  readonly provisionPermissionCatalogue: (prisma: PrismaClient) => Promise<number>;
}

const DEFAULT_STARTUP_HOOKS: DatabaseStartupHooks = {
  verifyDeploymentDatabase,
  provisionPermissionCatalogue,
};

/**
 * Admit a configured database before the API opens a listener.
 *
 * Production proves the exact migration/RLS/runtime-role contract first. Only
 * after that read-only admission succeeds do we install Korvi's global
 * permission vocabulary. The catalogue write is intentionally idempotent and
 * runs on every database-backed boot, so a newly deployed permission exists
 * before any control-plane tenant provisioning can reference it.
 *
 * Keeping the mutation after production preflight matters: a runtime pointed at
 * an unverified database must fail closed without modifying that database.
 */
export async function prepareApplicationDatabase(
  prisma: PrismaClient,
  config: Pick<ApiConfig, 'isProduction'>,
  hooks: DatabaseStartupHooks = DEFAULT_STARTUP_HOOKS,
): Promise<number> {
  if (config.isProduction) await hooks.verifyDeploymentDatabase(prisma);
  return hooks.provisionPermissionCatalogue(prisma);
}
