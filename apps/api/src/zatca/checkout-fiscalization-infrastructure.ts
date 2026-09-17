import type { PrismaClient } from '@korvi/database';
import { createZatcaCsidBindingRepository } from '@korvi/database/zatca-csid-binding';
import { createZatcaFiscalizationRepository } from '@korvi/database/zatca-fiscalization';
import { ZatcaInvoiceError } from '@korvi/domain';
import {
  AzureClientSecretAccessTokenProvider,
  AzureKeyVaultRestClient,
  AzureKeyVaultSigningKeyPort,
} from './azure-key-vault-signing-key.js';
import {
  createCheckoutFiscalizationPort,
  type CheckoutFiscalizationPort,
} from './fiscalize-checkout.js';
import { Libxml2ZatcaCanonicalizer } from './libxml2-canonicalizer.js';
import { createZatcaSimplifiedInvoiceSealer } from './seal-simplified-invoice.js';

export interface ProductionCheckoutFiscalizationOptions {
  readonly prisma: PrismaClient;
  readonly env?: NodeJS.ProcessEnv;
}

export function createProductionCheckoutFiscalization(
  options: ProductionCheckoutFiscalizationOptions,
): CheckoutFiscalizationPort {
  const env = options.env ?? process.env;
  const vaultName = required(env, 'AZURE_KEY_VAULT_NAME');
  if (!/^[A-Za-z0-9-]{3,24}$/.test(vaultName)) {
    throw new ZatcaInvoiceError('AZURE_KEY_VAULT_NAME is invalid.');
  }

  const tokenProvider = new AzureClientSecretAccessTokenProvider({
    tenantId: required(env, 'AZURE_TENANT_ID'),
    clientId: required(env, 'AZURE_CLIENT_ID'),
    clientSecret: required(env, 'AZURE_CLIENT_SECRET'),
  });
  const signingKey = new AzureKeyVaultSigningKeyPort({
    client: new AzureKeyVaultRestClient({
      vaultUrl: `https://${vaultName}.vault.azure.net`,
      accessTokenProvider: tokenProvider,
    }),
  });
  const repository = createZatcaFiscalizationRepository(options.prisma);
  const sealer = createZatcaSimplifiedInvoiceSealer({
    canonicalizer: new Libxml2ZatcaCanonicalizer(),
    signingKey,
    csidBindings: createZatcaCsidBindingRepository(options.prisma),
    trustedAnchorSha256Hex: trustAnchors(required(env, 'ZATCA_TRUST_ANCHOR_SHA256_HEX')),
  });
  return createCheckoutFiscalizationPort({ repository, sealer });
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new ZatcaInvoiceError(`${key} is required for production ZATCA fiscalization.`);
  }
  if (value !== value.trim()) {
    throw new ZatcaInvoiceError(`${key} must not contain surrounding whitespace.`);
  }
  return value;
}

function trustAnchors(value: string): readonly string[] {
  const anchors = value.split(',').map((entry) => entry.trim().toLowerCase());
  if (anchors.length === 0 || anchors.some((entry) => !/^[0-9a-f]{64}$/.test(entry))) {
    throw new ZatcaInvoiceError(
      'ZATCA_TRUST_ANCHOR_SHA256_HEX must contain comma-separated SHA-256 hex fingerprints.',
    );
  }
  return [...new Set(anchors)];
}
