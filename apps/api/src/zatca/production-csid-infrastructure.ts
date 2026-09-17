import { createZatcaFatooraCredentialRepository, type PrismaClient } from '@korvi/database';
import type { ZatcaProductionCsidIssuerPort } from '@korvi/domain';
import {
  createEncryptedZatcaFatooraCredentialStore,
  type EncryptedZatcaFatooraCredentialStore,
} from './encrypted-fatoora-credential-store.js';
import {
  requireZatcaFatooraVaultConfig,
  type ZatcaFatooraVaultConfig,
} from './fatoora-vault-config.js';
import { createZatcaProductionCsidHttpIssuer } from './production-csid-http-issuer.js';

export interface ZatcaProductionCsidInfrastructure {
  readonly credentialStore: EncryptedZatcaFatooraCredentialStore;
  readonly issuer: ZatcaProductionCsidIssuerPort;
}

export interface CreateZatcaProductionCsidInfrastructureOptions {
  readonly prisma: PrismaClient;
  readonly vault: ZatcaFatooraVaultConfig;
  readonly fetchImpl?: typeof fetch;
}

export interface CreateZatcaProductionCsidInfrastructureFromEnvironmentOptions {
  readonly prisma: PrismaClient;
  /** Process-secret boundary. Defaults to process.env only at this composition edge. */
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Compose Production-CSID issuance without widening the credential boundary.
 *
 * The same authenticated encrypted store is intentionally used as both the
 * current Compliance-CSID resolver and the destination for the newly issued
 * Production-CSID. Raw CSID credentials therefore exist only transiently inside
 * server-only adapters and never enter domain state or PostgreSQL plaintext.
 */
export function createZatcaProductionCsidInfrastructure(
  options: CreateZatcaProductionCsidInfrastructureOptions,
): ZatcaProductionCsidInfrastructure {
  const repository = createZatcaFatooraCredentialRepository(options.prisma);
  const credentialStore = createEncryptedZatcaFatooraCredentialStore({
    repository,
    activeKeyId: options.vault.activeKeyId,
    keys: options.vault.keys.map((entry) => ({
      id: entry.id,
      key: Uint8Array.from(entry.key),
    })),
  });
  const issuer =
    options.fetchImpl === undefined
      ? createZatcaProductionCsidHttpIssuer({
          credentialResolver: credentialStore,
          credentialStore,
        })
      : createZatcaProductionCsidHttpIssuer({
          credentialResolver: credentialStore,
          credentialStore,
          fetchImpl: options.fetchImpl,
        });

  return { credentialStore, issuer };
}

/**
 * Narrow production composition edge for Production-CSID onboarding.
 * General API configuration never receives Fatoora vault keys.
 */
export function createZatcaProductionCsidInfrastructureFromEnvironment(
  options: CreateZatcaProductionCsidInfrastructureFromEnvironmentOptions,
): ZatcaProductionCsidInfrastructure {
  const vault = requireZatcaFatooraVaultConfig(options.env);
  return options.fetchImpl === undefined
    ? createZatcaProductionCsidInfrastructure({ prisma: options.prisma, vault })
    : createZatcaProductionCsidInfrastructure({
        prisma: options.prisma,
        vault,
        fetchImpl: options.fetchImpl,
      });
}
