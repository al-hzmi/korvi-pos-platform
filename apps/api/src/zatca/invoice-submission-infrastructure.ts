import {
  createZatcaFatooraCredentialRepository,
  createZatcaInvoiceSubmissionRepository,
  type PrismaClient,
} from '@korvi/database';
import {
  createEncryptedZatcaFatooraCredentialStore,
  type EncryptedZatcaFatooraCredentialStore,
} from './encrypted-fatoora-credential-store.js';
import {
  requireZatcaFatooraVaultConfig,
  type ZatcaFatooraVaultConfig,
} from './fatoora-vault-config.js';
import { createZatcaInvoiceSubmissionHttpClient } from './invoice-submission-http-client.js';
import {
  createZatcaInvoiceSubmissionService,
  type ZatcaInvoiceSubmissionService,
} from './invoice-submission-service.js';

export interface ZatcaInvoiceSubmissionInfrastructure {
  readonly credentialStore: EncryptedZatcaFatooraCredentialStore;
  readonly service: ZatcaInvoiceSubmissionService;
}

export interface CreateZatcaInvoiceSubmissionInfrastructureOptions {
  readonly prisma: PrismaClient;
  readonly vault: ZatcaFatooraVaultConfig;
  readonly fetchImpl?: typeof fetch;
}

export interface CreateZatcaInvoiceSubmissionInfrastructureFromEnvironmentOptions {
  readonly prisma: PrismaClient;
  /** Process-secret boundary. Defaults to process.env only at this composition edge. */
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Production composition edge for Gate 40.
 *
 * No route or caller receives plaintext Production-CSID credentials. The HTTP
 * adapter resolves them inside the encrypted credential-store boundary, while
 * the service owns durable reservation, single-claim transition, uncertainty
 * and reconciliation semantics.
 */
export function createZatcaInvoiceSubmissionInfrastructure(
  options: CreateZatcaInvoiceSubmissionInfrastructureOptions,
): ZatcaInvoiceSubmissionInfrastructure {
  const credentialRepository = createZatcaFatooraCredentialRepository(options.prisma);
  const credentialStore = createEncryptedZatcaFatooraCredentialStore({
    repository: credentialRepository,
    activeKeyId: options.vault.activeKeyId,
    keys: options.vault.keys.map((entry) => ({ id: entry.id, key: Uint8Array.from(entry.key) })),
  });
  const submissionRepository = createZatcaInvoiceSubmissionRepository(options.prisma);
  const transport =
    options.fetchImpl === undefined
      ? createZatcaInvoiceSubmissionHttpClient({ credentialResolver: credentialStore })
      : createZatcaInvoiceSubmissionHttpClient({
          credentialResolver: credentialStore,
          fetchImpl: options.fetchImpl,
        });
  const service = createZatcaInvoiceSubmissionService({
    repository: submissionRepository,
    transport,
  });
  return { credentialStore, service };
}

/**
 * Narrow environment boundary. Vault keys are parsed only here and are not
 * added to the general API config surface.
 */
export function createZatcaInvoiceSubmissionInfrastructureFromEnvironment(
  options: CreateZatcaInvoiceSubmissionInfrastructureFromEnvironmentOptions,
): ZatcaInvoiceSubmissionInfrastructure {
  const vault = requireZatcaFatooraVaultConfig(options.env);
  return options.fetchImpl === undefined
    ? createZatcaInvoiceSubmissionInfrastructure({ prisma: options.prisma, vault })
    : createZatcaInvoiceSubmissionInfrastructure({
        prisma: options.prisma,
        vault,
        fetchImpl: options.fetchImpl,
      });
}
