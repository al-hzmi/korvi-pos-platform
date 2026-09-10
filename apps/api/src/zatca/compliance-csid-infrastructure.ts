import { createZatcaFatooraCredentialRepository, type PrismaClient } from '@korvi/database';
import type { ZatcaComplianceCsidIssuerPort } from '@korvi/domain';
import { createZatcaComplianceCsidHttpIssuer } from './compliance-csid-http-issuer.js';
import {
  createEncryptedZatcaFatooraCredentialStore,
  type EncryptedZatcaFatooraCredentialStore,
} from './encrypted-fatoora-credential-store.js';
import type { ZatcaFatooraVaultConfig } from './fatoora-vault-config.js';

export interface ZatcaComplianceCsidInfrastructure {
  readonly credentialStore: EncryptedZatcaFatooraCredentialStore;
  readonly issuer: ZatcaComplianceCsidIssuerPort;
}

export interface CreateZatcaComplianceCsidInfrastructureOptions {
  readonly prisma: PrismaClient;
  readonly vault: ZatcaFatooraVaultConfig;
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
