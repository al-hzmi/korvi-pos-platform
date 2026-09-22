import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  ZatcaInvoiceError,
  assertSameTenant,
  tenantId,
  type ActivateZatcaCsidBindingInput,
  type TenantScope,
  type ZatcaCertificatePathEntry,
  type ZatcaCertificateStatusEvidence,
  type ZatcaCsidBinding,
  type ZatcaCsidBindingRepository,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import { withTenant, type TransactionClient } from '../tenant-context.js';

interface BindingRow {
  tenantId: string;
  terminalId: string;
  credentialId: string;
  sourceAttemptId: string;
  state: 'active' | 'superseded' | 'revoked';
  keyProvider: string;
  keyId: string;
  keyExportable: boolean;
  certificatePath: unknown;
  certificateStatus: unknown;
  signingPublicKeySpkiDer: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  secretProvider: string;
  secretId: string;
  activatedAt: Date;
  supersededAt: Date | null;
  revokedAt: Date | null;
}

interface StoredCertificatePathEntry {
  readonly certificateDerBase64: string;
  readonly issuerName: string;
  readonly serialNumber: string;
}

/**
 * PostgreSQL authority for the one active Production CSID assigned to a terminal.
 *
 * The migration independently proves provenance against an issued Production-CSID
 * attempt and makes binding evidence immutable. This adapter adds tenant-scoped
 * reads, serializes replacement under a terminal row lock, and never accepts or
 * returns private signing material or a plaintext Fatoora secret.
 */
export function createZatcaCsidBindingRepository(prisma: PrismaClient): ZatcaCsidBindingRepository {
  return {
    findActiveForTerminal: (scope, terminalId) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        const row = await findActiveWithin(tx, scope, terminalId);
        return row === null ? null : mapBinding(scope, row);
      }),

    activate: (scope, input) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        assertActivationAuthority(scope, input);
        await lockTerminal(tx, scope, input.binding.terminalId);

        const replay = await findBySourceAttemptWithin(tx, scope, input.sourceAttemptId);
        if (replay !== null) {
          const stored = mapBinding(scope, replay);
          assertExactReplay(input.binding, stored, input.activatedAt, replay.activatedAt);
          if (stored.state !== 'active') {
            throw new ZatcaInvoiceError(
              'ZATCA Production CSID activation cannot reactivate superseded or revoked authority.',
            );
          }
          return stored;
        }

        const activatedAt = exactUtcSecond(input.activatedAt, 'activation timestamp');
        await tx.$executeRaw`
          UPDATE "zatca_csid_bindings"
             SET "state" = 'superseded',
                 "supersededAt" = ${activatedAt},
                 "updatedAt" = ${activatedAt}
           WHERE "tenantId" = ${scope.tenantId as string}::uuid
             AND "terminalId" = ${input.binding.terminalId}::uuid
             AND "state" = 'active'`;

        const certificatePath = JSON.stringify(
          serializeCertificatePath(input.binding.certificatePath),
        );
        const certificateStatus = JSON.stringify(input.binding.certificateStatus);
        const notBefore = exactUtcSecond(input.binding.notBefore, 'certificate notBefore');
        const notAfter = exactUtcSecond(input.binding.notAfter, 'certificate notAfter');
        const rows = await tx.$queryRaw<BindingRow[]>`
          INSERT INTO "zatca_csid_bindings" (
            "tenantId", "terminalId", "credentialId", "sourceAttemptId", "state",
            "keyProvider", "keyId", "keyExportable", "certificatePath", "certificateStatus",
            "signingPublicKeySpkiDer", "notBefore", "notAfter", "secretProvider", "secretId",
            "activatedAt", "updatedAt"
          ) VALUES (
            ${scope.tenantId as string}::uuid,
            ${input.binding.terminalId}::uuid,
            ${input.binding.credentialId},
            ${input.sourceAttemptId}::uuid,
            'active',
            ${input.binding.key.provider},
            ${input.binding.key.keyId},
            ${input.binding.key.exportable},
            ${certificatePath}::jsonb,
            ${certificateStatus}::jsonb,
            ${Buffer.from(input.binding.signingPublicKeySpkiDer)},
            ${notBefore},
            ${notAfter},
            ${input.binding.fatooraSecret.provider},
            ${input.binding.fatooraSecret.secretId},
            ${activatedAt},
            ${activatedAt}
          )
          RETURNING *`;

        const row = rows[0];
        if (row === undefined || rows.length !== 1) {
          throw new ZatcaInvoiceError(
            'ZATCA Production CSID activation did not create exactly one authority binding.',
          );
        }
        return mapBinding(scope, row);
      }),
  };
}

async function lockTerminal(
  tx: TransactionClient,
  scope: TenantScope,
  terminalId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
      FROM "terminals"
     WHERE "tenantId" = ${scope.tenantId as string}::uuid
       AND "id" = ${terminalId}::uuid
     FOR UPDATE`;
  if (rows.length !== 1) {
    throw new ZatcaInvoiceError(
      'ZATCA Production CSID activation requires an existing same-tenant terminal.',
    );
  }
}

async function findActiveWithin(
  tx: TransactionClient,
  scope: TenantScope,
  terminalId: string,
): Promise<BindingRow | null> {
  const rows = await tx.$queryRaw<BindingRow[]>`
    SELECT *
      FROM "zatca_csid_bindings"
     WHERE "tenantId" = ${scope.tenantId as string}::uuid
       AND "terminalId" = ${terminalId}::uuid
       AND "state" = 'active'
     LIMIT 1`;
  return rows[0] ?? null;
}

async function findBySourceAttemptWithin(
  tx: TransactionClient,
  scope: TenantScope,
  sourceAttemptId: string,
): Promise<BindingRow | null> {
  const rows = await tx.$queryRaw<BindingRow[]>`
    SELECT *
      FROM "zatca_csid_bindings"
     WHERE "tenantId" = ${scope.tenantId as string}::uuid
       AND "sourceAttemptId" = ${sourceAttemptId}::uuid
     LIMIT 1`;
  return rows[0] ?? null;
}

function assertActivationAuthority(scope: TenantScope, input: ActivateZatcaCsidBindingInput): void {
  if (input.binding.scope.tenantId !== scope.tenantId) {
    throw new ZatcaInvoiceError('ZATCA Production CSID activation refuses cross-tenant authority.');
  }
  if (input.binding.state !== 'active') {
    throw new ZatcaInvoiceError('A newly activated ZATCA Production CSID must start active.');
  }
  if (input.binding.terminalId.trim() === '' || input.binding.credentialId.trim() === '') {
    throw new ZatcaInvoiceError(
      'ZATCA Production CSID activation requires terminal and credential ids.',
    );
  }
  if (input.binding.key.exportable !== false) {
    throw new ZatcaInvoiceError(
      'ZATCA Production CSID activation refuses an exportable signing key.',
    );
  }
  if (input.binding.certificatePath.length < 2) {
    throw new ZatcaInvoiceError(
      'ZATCA Production CSID activation requires a complete certificate path.',
    );
  }
  if (input.binding.certificateStatus.length !== input.binding.certificatePath.length - 1) {
    throw new ZatcaInvoiceError(
      'ZATCA Production CSID activation requires status evidence for every non-anchor certificate.',
    );
  }
  exactUtcSecond(input.activatedAt, 'activation timestamp');
  exactUtcSecond(input.binding.notBefore, 'certificate notBefore');
  exactUtcSecond(input.binding.notAfter, 'certificate notAfter');
}

function serializeCertificatePath(
  certificatePath: readonly ZatcaCertificatePathEntry[],
): readonly StoredCertificatePathEntry[] {
  return certificatePath.map((entry) => ({
    certificateDerBase64: Buffer.from(entry.certificateDer).toString('base64'),
    issuerName: entry.issuerName,
    serialNumber: entry.serialNumber,
  }));
}

function mapBinding(scope: TenantScope, row: BindingRow): ZatcaCsidBinding {
  assertSameTenant(scope, row.tenantId);
  if (row.keyExportable !== false) {
    throw corrupt('signing key became exportable');
  }
  const binding: ZatcaCsidBinding = {
    credentialId: row.credentialId,
    scope: { tenantId: tenantId(row.tenantId) },
    terminalId: row.terminalId,
    state: row.state,
    key: {
      provider: row.keyProvider,
      keyId: row.keyId,
      curve: ZATCA_SIGNING_CURVE,
      algorithm: ZATCA_SIGNING_ALGORITHM,
      exportable: false,
    },
    certificatePath: parseCertificatePath(row.certificatePath),
    certificateStatus: parseCertificateStatus(row.certificateStatus),
    signingPublicKeySpkiDer: Uint8Array.from(row.signingPublicKeySpkiDer),
    notBefore: toUtcSecond(row.notBefore, 'certificate notBefore'),
    notAfter: toUtcSecond(row.notAfter, 'certificate notAfter'),
    fatooraSecret: { provider: row.secretProvider, secretId: row.secretId },
  };
  return binding;
}

function parseCertificatePath(value: unknown): readonly ZatcaCertificatePathEntry[] {
  if (!Array.isArray(value) || value.length < 2) throw corrupt('certificate path');
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw corrupt('certificate path entry');
    const certificateDerBase64 = stringField(candidate, 'certificateDerBase64');
    const issuerName = stringField(candidate, 'issuerName');
    const serialNumber = stringField(candidate, 'serialNumber');
    return {
      certificateDer: decodeCanonicalBase64(certificateDerBase64, 'certificate DER'),
      issuerName,
      serialNumber,
    };
  });
}

function parseCertificateStatus(value: unknown): readonly ZatcaCertificateStatusEvidence[] {
  if (!Array.isArray(value)) throw corrupt('certificate status');
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw corrupt('certificate status entry');
    const status = stringField(candidate, 'status');
    const source = stringField(candidate, 'source');
    if (status !== 'good' && status !== 'revoked' && status !== 'unknown') {
      throw corrupt('certificate status value');
    }
    if (source !== 'crl' && source !== 'ocsp') throw corrupt('certificate status source');
    const certificateSha256 = stringField(candidate, 'certificateSha256');
    if (decodeCanonicalBase64(certificateSha256, 'certificate fingerprint').length !== 32) {
      throw corrupt('certificate SHA-256 fingerprint');
    }
    return {
      certificateSha256,
      status,
      source,
      checkedAt: stringField(candidate, 'checkedAt'),
      validUntil: stringField(candidate, 'validUntil'),
    };
  });
}

function assertExactReplay(
  requested: ZatcaCsidBinding,
  stored: ZatcaCsidBinding,
  requestedActivatedAt: string,
  storedActivatedAt: Date,
): void {
  const same =
    requested.credentialId === stored.credentialId &&
    requested.scope.tenantId === stored.scope.tenantId &&
    requested.terminalId === stored.terminalId &&
    requested.state === stored.state &&
    requested.key.provider === stored.key.provider &&
    requested.key.keyId === stored.key.keyId &&
    requested.key.curve === stored.key.curve &&
    requested.key.algorithm === stored.key.algorithm &&
    requested.key.exportable === stored.key.exportable &&
    samePath(requested.certificatePath, stored.certificatePath) &&
    sameStatus(requested.certificateStatus, stored.certificateStatus) &&
    sameBytes(requested.signingPublicKeySpkiDer, stored.signingPublicKeySpkiDer) &&
    requested.notBefore === stored.notBefore &&
    requested.notAfter === stored.notAfter &&
    requested.fatooraSecret.provider === stored.fatooraSecret.provider &&
    requested.fatooraSecret.secretId === stored.fatooraSecret.secretId &&
    requestedActivatedAt === toUtcSecond(storedActivatedAt, 'activation timestamp');
  if (!same) {
    throw new ZatcaInvoiceError(
      'ZATCA Production CSID source attempt already has different durable binding evidence.',
    );
  }
}

function samePath(
  left: readonly ZatcaCertificatePathEntry[],
  right: readonly ZatcaCertificatePathEntry[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.issuerName === other.issuerName &&
        entry.serialNumber === other.serialNumber &&
        sameBytes(entry.certificateDer, other.certificateDer)
      );
    })
  );
}

function sameStatus(
  left: readonly ZatcaCertificateStatusEvidence[],
  right: readonly ZatcaCertificateStatusEvidence[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.certificateSha256 === other.certificateSha256 &&
        entry.status === other.status &&
        entry.source === other.source &&
        entry.checkedAt === other.checkedAt &&
        entry.validUntil === other.validUntil
      );
    })
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.trim() === '') throw corrupt(field);
  return candidate;
}

function decodeCanonicalBase64(value: string, label: string): Uint8Array {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) throw corrupt(label);
  return Uint8Array.from(bytes);
}

function exactUtcSecond(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) {
    throw new ZatcaInvoiceError(`ZATCA ${label} must be an exact UTC second.`);
  }
  const instant = Date.parse(value);
  if (
    !Number.isFinite(instant) ||
    new Date(instant).toISOString().replace('.000Z', 'Z') !== value
  ) {
    throw new ZatcaInvoiceError(`ZATCA ${label} is not a real UTC calendar instant.`);
  }
  return new Date(instant);
}

function toUtcSecond(value: Date, label: string): string {
  const iso = value.toISOString();
  if (!iso.endsWith('.000Z')) {
    throw corrupt(`${label} is not an exact UTC second`);
  }
  return iso.replace('.000Z', 'Z');
}

function corrupt(detail: string): ZatcaInvoiceError {
  return new ZatcaInvoiceError(`ZATCA persisted CSID binding ${detail} is corrupt.`);
}
