import {
  ZATCA_INITIAL_PREVIOUS_INVOICE_HASH,
  ZatcaFiscalizationError,
  assertSameTenant,
  tenantId,
  type SealZatcaFiscalizationInput,
  type TenantScope,
  type ZatcaDurableFiscalization,
  type ZatcaFiscalizationRepository,
  type ZatcaSellerFiscalProfile,
  type ZatcaSealedFiscalization,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import { withTenant, type TransactionClient } from '../tenant-context.js';

interface ProfileRow {
  tenantId: string;
  registrationName: string;
  vatRegistrationNumber: string;
  legalId: string;
  legalIdScheme: ZatcaSellerFiscalProfile['legalIdScheme'];
  streetName: string;
  buildingNumber: string;
  citySubdivisionName: string;
  cityName: string;
  postalZone: string;
  countryCode: 'SA';
}

interface ChainRow {
  tenantId: string;
  terminalId: string;
  nextIcv: bigint;
  previousInvoiceHash: string;
}

interface InvoiceAuthorityRow {
  sellerName: string;
  sellerVatNumber: string;
  terminalId: string;
}

interface FiscalizationRow {
  tenantId: string;
  invoiceId: string;
  terminalId: string;
  invoiceCounterValue: bigint;
  previousInvoiceHash: string;
  sellerRegistrationName: string;
  sellerVatRegistrationNumber: string;
  sellerLegalId: string;
  sellerLegalIdScheme: ZatcaSellerFiscalProfile['legalIdScheme'];
  sellerStreetName: string;
  sellerBuildingNumber: string;
  sellerCitySubdivisionName: string;
  sellerCityName: string;
  sellerPostalZone: string;
  sellerCountryCode: 'SA';
  state: 'reserved' | 'sealed';
  invoiceHash: Uint8Array | null;
  sealedInvoiceXml: Uint8Array | null;
  qrCodeBase64: string | null;
  signatureValueBase64: string | null;
  reservedAt: Date;
  sealedAt: Date | null;
}

export function createZatcaFiscalizationRepository(
  prisma: PrismaClient,
): ZatcaFiscalizationRepository {
  return {
    readSellerProfile: (scope) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => readProfileWithin(tx, scope)),

    upsertSellerProfile: (scope, profile, updatedAt) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        const rows = await tx.$queryRaw<ProfileRow[]>`
          INSERT INTO "zatca_seller_fiscal_profiles" (
            "tenantId", "registrationName", "vatRegistrationNumber", "legalId", "legalIdScheme",
            "streetName", "buildingNumber", "citySubdivisionName", "cityName", "postalZone",
            "countryCode", "updatedAt"
          ) VALUES (
            ${scope.tenantId as string}::uuid,
            ${profile.registrationName}, ${profile.vatRegistrationNumber}, ${profile.legalId},
            ${profile.legalIdScheme}, ${profile.streetName}, ${profile.buildingNumber},
            ${profile.citySubdivisionName}, ${profile.cityName}, ${profile.postalZone},
            ${profile.countryCode}, ${new Date(updatedAt)}
          )
          ON CONFLICT ("tenantId") DO UPDATE SET
            "registrationName" = EXCLUDED."registrationName",
            "vatRegistrationNumber" = EXCLUDED."vatRegistrationNumber",
            "legalId" = EXCLUDED."legalId",
            "legalIdScheme" = EXCLUDED."legalIdScheme",
            "streetName" = EXCLUDED."streetName",
            "buildingNumber" = EXCLUDED."buildingNumber",
            "citySubdivisionName" = EXCLUDED."citySubdivisionName",
            "cityName" = EXCLUDED."cityName",
            "postalZone" = EXCLUDED."postalZone",
            "countryCode" = EXCLUDED."countryCode",
            "updatedAt" = EXCLUDED."updatedAt"
          RETURNING
            "tenantId", "registrationName", "vatRegistrationNumber", "legalId", "legalIdScheme",
            "streetName", "buildingNumber", "citySubdivisionName", "cityName", "postalZone",
            "countryCode"`;
        const row = rows[0];
        if (row === undefined) throw new ZatcaFiscalizationError('Seller fiscal profile was not persisted.');
        return mapProfile(scope, row);
      }),

    findByInvoice: (scope, invoiceId) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        const row = await findByInvoiceWithin(tx, scope, invoiceId);
        return row === null ? null : mapFiscalization(scope, row);
      }),

    reserve: (scope, input) =>
      withTenant(prisma, scope.tenantId as string, async (tx) => {
        const existing = await findByInvoiceWithin(tx, scope, input.invoiceId);
        if (existing !== null) {
          const durable = mapFiscalization(scope, existing);
          if (durable.terminalId !== input.terminalId) {
            throw new ZatcaFiscalizationError('Fiscalization replay named a different terminal.');
          }
          return durable;
        }

        const profile = await readProfileWithin(tx, scope);
        if (profile === null) {
          throw new ZatcaFiscalizationError('ZATCA seller fiscal profile is not configured.');
        }
        const authority = await readInvoiceAuthority(tx, scope, input.invoiceId);
        if (authority === null) {
          throw new ZatcaFiscalizationError('ZATCA invoice authority is missing.');
        }
        if (authority.terminalId !== input.terminalId) {
          throw new ZatcaFiscalizationError('Fiscalization terminal contradicts the immutable sale terminal.');
        }
        if (
          authority.sellerName !== profile.registrationName ||
          authority.sellerVatNumber !== profile.vatRegistrationNumber
        ) {
          throw new ZatcaFiscalizationError(
            'Invoice seller snapshot diverges from the configured ZATCA fiscal profile.',
          );
        }

        await tx.$executeRaw`
          INSERT INTO "zatca_terminal_fiscal_chains" (
            "tenantId", "terminalId", "nextIcv", "previousInvoiceHash", "updatedAt"
          ) VALUES (
            ${scope.tenantId as string}::uuid,
            ${input.terminalId}::uuid,
            1,
            ${ZATCA_INITIAL_PREVIOUS_INVOICE_HASH},
            ${new Date(input.reservedAt)}
          )
          ON CONFLICT ("tenantId", "terminalId") DO NOTHING`;

        const chains = await tx.$queryRaw<ChainRow[]>`
          SELECT "tenantId", "terminalId", "nextIcv", "previousInvoiceHash"
            FROM "zatca_terminal_fiscal_chains"
           WHERE "tenantId" = ${scope.tenantId as string}::uuid
             AND "terminalId" = ${input.terminalId}::uuid
           FOR UPDATE`;
        const chain = chains[0];
        if (chain === undefined) {
          throw new ZatcaFiscalizationError('Terminal fiscal chain could not be locked.');
        }
        assertSameTenant(scope, chain.tenantId);

        // A concurrent replay can have won while this transaction waited for
        // the terminal-chain lock. Converge on it instead of allocating again.
        const replay = await findByInvoiceWithin(tx, scope, input.invoiceId);
        if (replay !== null) return mapFiscalization(scope, replay);

        const blocked = await tx.$queryRaw<Array<{ invoiceId: string }>>`
          SELECT "invoiceId"
            FROM "zatca_invoice_fiscalizations"
           WHERE "tenantId" = ${scope.tenantId as string}::uuid
             AND "terminalId" = ${input.terminalId}::uuid
             AND "state" = 'reserved'
           LIMIT 1`;
        if (blocked[0] !== undefined) {
          throw new ZatcaFiscalizationError(
            `Terminal fiscal chain is waiting for invoice ${blocked[0].invoiceId} to be sealed.`,
          );
        }

        const rows = await tx.$queryRaw<FiscalizationRow[]>`
          INSERT INTO "zatca_invoice_fiscalizations" (
            "tenantId", "invoiceId", "terminalId", "invoiceCounterValue", "previousInvoiceHash",
            "sellerRegistrationName", "sellerVatRegistrationNumber", "sellerLegalId",
            "sellerLegalIdScheme", "sellerStreetName", "sellerBuildingNumber",
            "sellerCitySubdivisionName", "sellerCityName", "sellerPostalZone", "sellerCountryCode",
            "state", "reservedAt", "updatedAt"
          ) VALUES (
            ${scope.tenantId as string}::uuid,
            ${input.invoiceId}::uuid,
            ${input.terminalId}::uuid,
            ${chain.nextIcv},
            ${chain.previousInvoiceHash},
            ${profile.registrationName}, ${profile.vatRegistrationNumber}, ${profile.legalId},
            ${profile.legalIdScheme}, ${profile.streetName}, ${profile.buildingNumber},
            ${profile.citySubdivisionName}, ${profile.cityName}, ${profile.postalZone},
            ${profile.countryCode},
            'reserved', ${new Date(input.reservedAt)}, ${new Date(input.reservedAt)}
          )
          RETURNING *`;
        const row = rows[0];
        if (row === undefined) throw new ZatcaFiscalizationError('Fiscalization reservation was not persisted.');
        return mapFiscalization(scope, row);
      }),

    seal: (scope, input) => sealWithin(prisma, scope, input),
  };
}

async function sealWithin(
  prisma: PrismaClient,
  scope: TenantScope,
  input: SealZatcaFiscalizationInput,
): Promise<ZatcaSealedFiscalization> {
  return withTenant(prisma, scope.tenantId as string, async (tx) => {
    const rows = await tx.$queryRaw<FiscalizationRow[]>`
      SELECT * FROM "zatca_invoice_fiscalizations"
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "invoiceId" = ${input.invoiceId}::uuid
       FOR UPDATE`;
    const row = rows[0];
    if (row === undefined) throw new ZatcaFiscalizationError('Fiscalization reservation is missing.');
    const current = mapFiscalization(scope, row);
    if (current.terminalId !== input.terminalId) {
      throw new ZatcaFiscalizationError('Fiscalization seal named a different terminal.');
    }
    if (current.state === 'sealed') {
      assertSealedReplay(current, input);
      return current;
    }

    const chains = await tx.$queryRaw<ChainRow[]>`
      SELECT "tenantId", "terminalId", "nextIcv", "previousInvoiceHash"
        FROM "zatca_terminal_fiscal_chains"
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "terminalId" = ${input.terminalId}::uuid
       FOR UPDATE`;
    const chain = chains[0];
    if (chain === undefined) throw new ZatcaFiscalizationError('Terminal fiscal chain is missing.');
    if (
      chain.nextIcv.toString() !== current.invoiceCounterValue ||
      chain.previousInvoiceHash !== current.previousInvoiceHash
    ) {
      throw new ZatcaFiscalizationError('Terminal fiscal chain diverged from the invoice reservation.');
    }

    const sealedRows = await tx.$queryRaw<FiscalizationRow[]>`
      UPDATE "zatca_invoice_fiscalizations"
         SET "state" = 'sealed',
             "invoiceHash" = ${Buffer.from(input.invoiceHash)},
             "sealedInvoiceXml" = ${Buffer.from(input.sealedInvoiceXml)},
             "qrCodeBase64" = ${input.qrCodeBase64},
             "signatureValueBase64" = ${input.signatureValueBase64},
             "sealedAt" = ${new Date(input.sealedAt)},
             "updatedAt" = ${new Date(input.sealedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "invoiceId" = ${input.invoiceId}::uuid
         AND "state" = 'reserved'
      RETURNING *`;
    const sealedRow = sealedRows[0];
    if (sealedRow === undefined) {
      throw new ZatcaFiscalizationError('Fiscalization reservation did not transition to sealed.');
    }

    const nextIcv = chain.nextIcv + 1n;
    const nextPih = Buffer.from(input.invoiceHash).toString('base64');
    const advanced = await tx.$executeRaw`
      UPDATE "zatca_terminal_fiscal_chains"
         SET "nextIcv" = ${nextIcv},
             "previousInvoiceHash" = ${nextPih},
             "updatedAt" = ${new Date(input.sealedAt)}
       WHERE "tenantId" = ${scope.tenantId as string}::uuid
         AND "terminalId" = ${input.terminalId}::uuid
         AND "nextIcv" = ${chain.nextIcv}
         AND "previousInvoiceHash" = ${chain.previousInvoiceHash}`;
    if (advanced !== 1) {
      throw new ZatcaFiscalizationError('Terminal fiscal chain was not advanced exactly once.');
    }

    return expectSealed(mapFiscalization(scope, sealedRow));
  });
}

async function readProfileWithin(
  tx: TransactionClient,
  scope: TenantScope,
): Promise<ZatcaSellerFiscalProfile | null> {
  const rows = await tx.$queryRaw<ProfileRow[]>`
    SELECT
      "tenantId", "registrationName", "vatRegistrationNumber", "legalId", "legalIdScheme",
      "streetName", "buildingNumber", "citySubdivisionName", "cityName", "postalZone", "countryCode"
      FROM "zatca_seller_fiscal_profiles"
     WHERE "tenantId" = ${scope.tenantId as string}::uuid
     LIMIT 1`;
  const row = rows[0];
  return row === undefined ? null : mapProfile(scope, row);
}

async function readInvoiceAuthority(
  tx: TransactionClient,
  scope: TenantScope,
  invoiceId: string,
): Promise<InvoiceAuthorityRow | null> {
  const rows = await tx.$queryRaw<InvoiceAuthorityRow[]>`
    SELECT i."sellerName", i."sellerVatNumber", s."terminalId"
      FROM "invoices" i
      JOIN "sales" s
        ON s."tenantId" = i."tenantId" AND s."id" = i."saleId"
     WHERE i."tenantId" = ${scope.tenantId as string}::uuid
       AND i."id" = ${invoiceId}::uuid
       AND i."invoiceType" = 'simplified'
     LIMIT 1`;
  return rows[0] ?? null;
}

async function findByInvoiceWithin(
  tx: TransactionClient,
  scope: TenantScope,
  invoiceId: string,
): Promise<FiscalizationRow | null> {
  const rows = await tx.$queryRaw<FiscalizationRow[]>`
    SELECT * FROM "zatca_invoice_fiscalizations"
     WHERE "tenantId" = ${scope.tenantId as string}::uuid
       AND "invoiceId" = ${invoiceId}::uuid
     LIMIT 1`;
  const row = rows[0] ?? null;
  if (row !== null) assertSameTenant(scope, row.tenantId);
  return row;
}

function mapProfile(scope: TenantScope, row: ProfileRow): ZatcaSellerFiscalProfile {
  assertSameTenant(scope, row.tenantId);
  return {
    registrationName: row.registrationName,
    vatRegistrationNumber: row.vatRegistrationNumber,
    legalId: row.legalId,
    legalIdScheme: row.legalIdScheme,
    streetName: row.streetName,
    buildingNumber: row.buildingNumber,
    citySubdivisionName: row.citySubdivisionName,
    cityName: row.cityName,
    postalZone: row.postalZone,
    countryCode: row.countryCode,
  };
}

function mapFiscalization(scope: TenantScope, row: FiscalizationRow): ZatcaDurableFiscalization {
  assertSameTenant(scope, row.tenantId);
  const base = {
    scope: { tenantId: tenantId(row.tenantId) },
    invoiceId: row.invoiceId,
    terminalId: row.terminalId,
    invoiceCounterValue: row.invoiceCounterValue.toString(),
    previousInvoiceHash: row.previousInvoiceHash,
    seller: {
      registrationName: row.sellerRegistrationName,
      vatRegistrationNumber: row.sellerVatRegistrationNumber,
      legalId: row.sellerLegalId,
      legalIdScheme: row.sellerLegalIdScheme,
      streetName: row.sellerStreetName,
      buildingNumber: row.sellerBuildingNumber,
      citySubdivisionName: row.sellerCitySubdivisionName,
      cityName: row.sellerCityName,
      postalZone: row.sellerPostalZone,
      countryCode: row.sellerCountryCode,
    },
    reservedAt: toUtcSecond(row.reservedAt),
  } as const;

  if (row.state === 'reserved') return { ...base, state: 'reserved' };
  if (
    row.invoiceHash === null ||
    row.sealedInvoiceXml === null ||
    row.qrCodeBase64 === null ||
    row.signatureValueBase64 === null ||
    row.sealedAt === null
  ) {
    throw new ZatcaFiscalizationError('Persisted sealed fiscalization is incomplete.');
  }
  return {
    ...base,
    state: 'sealed',
    invoiceHash: Uint8Array.from(row.invoiceHash),
    sealedInvoiceXml: Uint8Array.from(row.sealedInvoiceXml),
    qrCodeBase64: row.qrCodeBase64,
    signatureValueBase64: row.signatureValueBase64,
    sealedAt: toUtcSecond(row.sealedAt),
  };
}

function assertSealedReplay(
  current: ZatcaSealedFiscalization,
  input: SealZatcaFiscalizationInput,
): void {
  if (
    !sameBytes(current.invoiceHash, input.invoiceHash) ||
    !sameBytes(current.sealedInvoiceXml, input.sealedInvoiceXml) ||
    current.qrCodeBase64 !== input.qrCodeBase64 ||
    current.signatureValueBase64 !== input.signatureValueBase64 ||
    current.sealedAt !== input.sealedAt
  ) {
    throw new ZatcaFiscalizationError('Sealed fiscalization replay carries different evidence.');
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function expectSealed(value: ZatcaDurableFiscalization): ZatcaSealedFiscalization {
  if (value.state !== 'sealed') throw new ZatcaFiscalizationError('Expected sealed fiscalization.');
  return value;
}

function toUtcSecond(value: Date): string {
  const iso = value.toISOString();
  if (!iso.endsWith('.000Z')) {
    throw new ZatcaFiscalizationError('Persisted fiscalization timestamp is not an exact UTC second.');
  }
  return iso.replace('.000Z', 'Z');
}
