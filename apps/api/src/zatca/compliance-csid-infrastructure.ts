import { createZatcaFatooraCredentialRepository, type PrismaClient } from '@korvi/database';
import type { ZatcaComplianceCsidIssuerPort } from '@korvi/domain';
import { createZatcaComplianceCsidHttpIssuer } from './compliance-csid-http-issuer.js';
import {
  createEncryptedZatcaFatooraCredentialStore,
  type EncryptedZatcaFatooraCredentialStore,
} from './encrypted-fatoora-credential-store.js';
import {
  requireZatcaFatooraVaultConfig,
  type ZatcaFatooraVaultConfig,
} from './fatoora-vault-config.js';

export interface ZatcaComplianceCsidInfrastructure {
  readonly credentialStore: EncryptedZatcaFatooraCredentialStore;
  readonly issuer: ZatcaComplianceCsidIssuerPort;
}

export interface CreateZatcaComplianceCsidInfrastructureOptions {
  readonly prisma: PrismaClient;
  readonly vault: ZatcaFatooraVaultConfig;
  readonly fetchImpl?: typeof fetch;
}

export interface CreateZatcaComplianceCsidInfrastructureFromEnvironmentOptions {
  readonly prisma: PrismaClient;
  /** Process-secret boundary. Defaults to process.env only at this composition edge. */
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Compose the production Compliance-CSID credential boundary.
 *
 * This is intentionally the only adapter-level path from Prisma to the raw
 * Fatoora credential store: PostgreSQL receives ciphertext through the narrow
 * repository, while the HTTP issuer receives only the encrypted store port.
 * The raw ZATCA token and secret therefore never cross into the domain model or
 * the provisioning repository.
 */
export function createZatcaComplianceCsidInfrastructure(
  options: CreateZatcaComplianceCsidInfrastructureOptions,
): ZatcaComplianceCsidInfrastructure {
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
      ? createZatcaComplianceCsidHttpIssuer({ credentialStore })
      : createZatcaComplianceCsidHttpIssuer({ credentialStore, fetchImpl: options.fetchImpl });

  return { credentialStore, issuer };
}

/**
 * Production composition edge for the Fatoora vault keyring.
 *
 * Raw AES keys are deliberately not added to the general ApiConfig object: that
 * object is passed to unrelated HTTP/runtime components. Only this narrow
 * ZATCA composition path reads the process-secret variables, fails closed when
 * either half of the keyring configuration is missing, and immediately hands
 * decoded key bytes to the encrypted credential store.
 */
export function createZatcaComplianceCsidInfrastructureFromEnvironment(
  options: CreateZatcaComplianceCsidInfrastructureFromEnvironmentOptions,
): ZatcaComplianceCsidInfrastructure {
  const vault = requireZatcaFatooraVaultConfig(options.env);
  return options.fetchImpl === undefined
    ? createZatcaComplianceCsidInfrastructure({ prisma: options.prisma, vault })
    : createZatcaComplianceCsidInfrastructure({
        prisma: options.prisma,
        vault,
        fetchImpl: options.fetchImpl,
      });
}
