import { assertSameTenant } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { withTenant } from '../tenant-context.js';
import type { TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

export interface ZatcaFatooraCiphertextRecord {
  readonly terminalId: string;
  readonly credentialId: string;
  readonly keyId: string;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authTag: Uint8Array;
}

export interface ZatcaFatooraCredentialRepository {
  /**
   * Insert encrypted credential material once, or return the existing row for
   * the same tenant + credential identity. The implementation never overwrites
   * ciphertext during an issuance retry.
   */
  reserve(
    scope: TenantScope,
    record: ZatcaFatooraCiphertextRecord,
  ): Promise<ZatcaFatooraCiphertextRecord>;

  find(
    scope: TenantScope,
    terminalId: string,
    credentialId: string,
  ): Promise<ZatcaFatooraCiphertextRecord | null>;
}

interface CredentialRow {
  tenantId: string;
  terminalId: string;
  credentialId: string;
  keyId: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  authTag: Uint8Array;
}

/**
 * Tenant-RLS persistence for encrypted Fatoora credentials.
 *
 * This repository deliberately knows nothing about encryption keys or
 * plaintext ZATCA secrets. It receives authenticated ciphertext only. The
 * tenant + credential uniqueness constraint makes one issued credential bind
 * to one terminal even under concurrent writers.
 */
export function createZatcaFatooraCredentialRepository(
  prisma: PrismaClient,
): ZatcaFatooraCredentialRepository {
  return {
    reserve: (scope, record) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        const rows = await tx.$queryRaw<CredentialRow[]>`
          INSERT INTO "zatca_fatoora_credentials" (
            "tenantId", "terminalId", "credentialId", "keyId",
            "nonce", "ciphertext", "authTag", "updatedAt"
          ) VALUES (
            ${scope.tenantId as string}::uuid,
            ${record.terminalId}::uuid,
            ${record.credentialId},
            ${record.keyId},
            ${Buffer.from(record.nonce)},
            ${Buffer.from(record.ciphertext)},
            ${Buffer.from(record.authTag)},
            CURRENT_TIMESTAMP
          )
          ON CONFLICT ("tenantId", "credentialId") DO NOTHING
          RETURNING "tenantId", "terminalId", "credentialId", "keyId",
                    "nonce", "ciphertext", "authTag"`;

        const row = rows[0] ?? (await findByCredentialWithin(tx, scope, record.credentialId));
        if (row === null) {
          throw new DatabaseError('ZATCA Fatoora credential reservation lost its durable row.');
        }
        if (row.terminalId !== record.terminalId) {
          throw new DatabaseError(
            'ZATCA Fatoora credential is already bound to a different terminal.',
          );
        }
        return mapRow(scope, row);
      }),

    find: (scope, terminalId, credentialId) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        const rows = await tx.$queryRaw<CredentialRow[]>`
          SELECT "tenantId", "terminalId", "credentialId", "keyId",
                 "nonce", "ciphertext", "authTag"
            FROM "zatca_fatoora_credentials"
           WHERE "tenantId" = ${scope.tenantId as string}::uuid
             AND "terminalId" = ${terminalId}::uuid
             AND "credentialId" = ${credentialId}
           LIMIT 1`;
        const row = rows[0];
        return row === undefined ? null : mapRow(scope, row);
      }),
  };
}

async function findByCredentialWithin(
  tx: TransactionClient,
  scope: TenantScope,
  credentialId: string,
): Promise<CredentialRow | null> {
  const rows = await tx.$queryRaw<CredentialRow[]>`
    SELECT "tenantId", "terminalId", "credentialId", "keyId",
           "nonce", "ciphertext", "authTag"
      FROM "zatca_fatoora_credentials"
     WHERE "tenantId" = ${scope.tenantId as string}::uuid
       AND "credentialId" = ${credentialId}
     LIMIT 1`;
  return rows[0] ?? null;
}

function mapRow(scope: TenantScope, row: CredentialRow): ZatcaFatooraCiphertextRecord {
  assertSameTenant(scope, row.tenantId);
  return {
    terminalId: row.terminalId,
    credentialId: row.credentialId,
    keyId: row.keyId,
    nonce: Uint8Array.from(row.nonce),
    ciphertext: Uint8Array.from(row.ciphertext),
    authTag: Uint8Array.from(row.authTag),
  };
}
