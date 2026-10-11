import { createHash } from 'node:crypto';
import {
  assertQuantityShape,
  newId,
  reviewOpeningInventorySheet,
  summarizeImportReviews,
} from '@korvi/domain';
import { DatabaseError, StockOperationRefusedError } from '../errors.js';
import {
  lockBalances,
  lockBranches,
  lockProducts,
  lockedOrThrow,
} from '../inventory/stock-ledger.js';
import { applyMovementWithin } from '../repositories/inventory-repository.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type {
  CanonicalOpeningInventoryImportRow,
  OpeningInventoryColumnMapping,
  OpeningInventoryImportField,
  ImportClassification,
  ImportIssue,
  ImportSheet,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const ROW_BATCH = 200;
const SUMMARY_ROW_PREVIEW_LIMIT = 50;

export type OpeningInventoryImportRefusal =
  | 'unknown-job'
  | 'invalid-source-hash'
  | 'invalid-operation'
  | 'idempotency-conflict'
  | 'job-not-ready';

export class OpeningInventoryImportRefusedError extends DatabaseError {
  public override readonly name = 'OpeningInventoryImportRefusedError';

  public constructor(public readonly detail: OpeningInventoryImportRefusal) {
    super('Opening inventory import refused: ' + detail);
  }
}

export interface OpeningInventoryImportActor {
  readonly userId: string;
}

export interface CreateOpeningInventoryImportJobRequest {
  readonly operationId: string;
  readonly sourceSha256: string;
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sheet: ImportSheet;
  readonly mapping: readonly OpeningInventoryColumnMapping[];
}

export interface OpeningInventoryImportRowResult {
  readonly sourceRow: number;
  readonly sourceIdentifier: string | null;
  readonly classification: ImportClassification;
  readonly plannedAction: 'create' | 'reject';
  readonly status: 'pending' | 'committing' | 'rejected' | 'committed' | 'failed';
  readonly targetEntityId: string | null;
  readonly errorCode: string | null;
  readonly issues: readonly ImportIssue[];
}

export interface OpeningInventoryImportRowPage {
  readonly rows: readonly OpeningInventoryImportRowResult[];
  readonly nextAfterSourceRow: number | null;
}

export interface OpeningInventoryImportSummary {
  readonly id: string;
  readonly domain: 'opening-inventory';
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceSha256: string;
  readonly status: 'reviewed' | 'dry-run' | 'committing' | 'completed';
  readonly mappingVersion: number;
  readonly mapping: readonly OpeningInventoryColumnMapping[];
  readonly conflictPolicy: 'reject';
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
  readonly created: number;
  readonly failed: number;
  readonly rejected: number;
  readonly rows: readonly OpeningInventoryImportRowResult[];
  readonly rowsTruncated: boolean;
  readonly createdAt: string;
  readonly dryRunAt: string | null;
  readonly commitAt: string | null;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function jsonObject(value: unknown): object {
  return JSON.parse(JSON.stringify(value)) as object;
}

function issueFromUnknown(value: unknown): ImportIssue | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const classification = candidate.classification;
  if (classification !== 'WARNING' && classification !== 'ERROR' && classification !== 'BLOCKED') {
    return null;
  }
  if (typeof candidate.code !== 'string' || typeof candidate.message !== 'string') return null;
  return {
    classification,
    code: candidate.code,
    message: candidate.message,
    row: typeof candidate.row === 'number' ? candidate.row : null,
    sourceColumn: typeof candidate.sourceColumn === 'number' ? candidate.sourceColumn : null,
    targetField: typeof candidate.targetField === 'string' ? candidate.targetField : null,
  };
}

function issuesFromUnknown(value: unknown): ImportIssue[] {
  if (!Array.isArray(value)) return [];
  return value.map(issueFromUnknown).filter((issue): issue is ImportIssue => issue !== null);
}

function mappingFromUnknown(value: unknown): OpeningInventoryColumnMapping[] {
  if (!Array.isArray(value))
    throw new DatabaseError('Opening inventory import mapping is corrupt.');
  const fields = new Set<OpeningInventoryImportField>(['branchCode', 'sku', 'openingQuantity']);
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DatabaseError('Opening inventory import mapping is corrupt.');
    }
    const candidate = entry as Record<string, unknown>;
    if (!Number.isInteger(candidate.sourceColumn) || (candidate.sourceColumn as number) < 0) {
      throw new DatabaseError('Opening inventory import mapping is corrupt.');
    }
    const target = candidate.targetField;
    if (
      target !== null &&
      (typeof target !== 'string' || !fields.has(target as OpeningInventoryImportField))
    ) {
      throw new DatabaseError('Opening inventory import mapping is corrupt.');
    }
    return {
      sourceColumn: candidate.sourceColumn as number,
      targetField: target as OpeningInventoryImportField | null,
    };
  });
}

function canonicalFromUnknown(value: unknown): CanonicalOpeningInventoryImportRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatabaseError('Opening inventory import canonical row is missing.');
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.branchCode !== 'string' ||
    typeof row.sku !== 'string' ||
    typeof row.quantityScaled !== 'string' ||
    !/^\d+$/u.test(row.quantityScaled) ||
    row.quantityScaled === '0'
  ) {
    throw new DatabaseError('Opening inventory import canonical row is corrupt.');
  }
  return {
    branchCode: row.branchCode,
    sku: row.sku,
    quantityScaled: row.quantityScaled,
  };
}

class OpeningInventoryRowRefusedError extends Error {
  public override readonly name = 'OpeningInventoryRowRefusedError';

  public constructor(
    public readonly detail:
      | 'unknown-branch'
      | 'inactive-branch'
      | 'unknown-product'
      | 'inactive-product'
      | 'untracked-product'
      | 'invalid-quantity-shape'
      | 'opening-stock-not-pristine',
  ) {
    super('Opening inventory row refused: ' + detail);
  }
}

function openingIssue(
  sourceRow: number,
  code: OpeningInventoryRowRefusedError['detail'],
): ImportIssue {
  const messages: Readonly<Record<OpeningInventoryRowRefusedError['detail'], string>> = {
    'unknown-branch': 'The branch code does not exist in this merchant.',
    'inactive-branch': 'The branch is inactive.',
    'unknown-product': 'The SKU does not exist in this merchant catalogue.',
    'inactive-product': 'The product is inactive.',
    'untracked-product': 'The product does not track inventory.',
    'invalid-quantity-shape': 'The opening quantity is not valid for this product type.',
    'opening-stock-not-pristine':
      'Opening stock requires a pristine zero balance with no prior quantity-changing movement.',
  };
  return {
    classification: 'ERROR',
    code,
    message: messages[code],
    row: sourceRow,
    sourceColumn: null,
    targetField:
      code.startsWith('unknown-branch') || code === 'inactive-branch'
        ? 'branchCode'
        : code === 'invalid-quantity-shape'
          ? 'openingQuantity'
          : 'sku',
  };
}

async function resolveOpeningIdentityWithin(
  tx: TransactionClient,
  tenant: string,
  canonical: CanonicalOpeningInventoryImportRow,
): Promise<{
  readonly branchId: string;
  readonly productId: string;
  readonly productType: 'unit' | 'weighted';
}> {
  const branch = await tx.branch.findFirst({
    where: { tenantId: tenant, code: canonical.branchCode },
    select: { id: true, isActive: true },
  });
  if (branch === null) throw new OpeningInventoryRowRefusedError('unknown-branch');
  if (!branch.isActive) throw new OpeningInventoryRowRefusedError('inactive-branch');

  const product = await tx.product.findFirst({
    where: { tenantId: tenant, sku: canonical.sku },
    select: { id: true, isActive: true, trackInventory: true, productType: true },
  });
  if (product === null) throw new OpeningInventoryRowRefusedError('unknown-product');
  if (!product.isActive) throw new OpeningInventoryRowRefusedError('inactive-product');
  if (!product.trackInventory) throw new OpeningInventoryRowRefusedError('untracked-product');
  const productType = product.productType === 'weighted' ? 'weighted' : 'unit';
  try {
    assertQuantityShape(BigInt(canonical.quantityScaled), productType, 'openingQuantity');
  } catch {
    throw new OpeningInventoryRowRefusedError('invalid-quantity-shape');
  }
  return { branchId: branch.id, productId: product.id, productType };
}

async function assertPristineOpeningBalanceWithin(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
  productId: string,
): Promise<void> {
  const balance = await tx.inventoryBalance.findFirst({
    where: { tenantId: tenant, branchId, productId },
    select: { quantityScaled: true, revision: true },
  });
  if (balance !== null && (balance.quantityScaled !== 0n || balance.revision !== 0n)) {
    throw new OpeningInventoryRowRefusedError('opening-stock-not-pristine');
  }
}

function openingInventoryRowResult(row: {
  sourceRow: number;
  sourceIdentifier: string | null;
  classification: string;
  plannedAction: string;
  status: string;
  targetEntityId: string | null;
  errorCode: string | null;
  issues: unknown;
}): OpeningInventoryImportRowResult {
  if (
    row.classification !== 'VALID' &&
    row.classification !== 'WARNING' &&
    row.classification !== 'ERROR' &&
    row.classification !== 'BLOCKED'
  ) {
    throw new DatabaseError('Opening inventory import row carries unknown classification.');
  }
  if (row.plannedAction !== 'create' && row.plannedAction !== 'reject') {
    throw new DatabaseError('Opening inventory import row carries unknown action.');
  }
  if (
    row.status !== 'pending' &&
    row.status !== 'committing' &&
    row.status !== 'rejected' &&
    row.status !== 'committed' &&
    row.status !== 'failed'
  ) {
    throw new DatabaseError('Opening inventory import row carries unknown status.');
  }
  return {
    sourceRow: row.sourceRow,
    sourceIdentifier: row.sourceIdentifier,
    classification: row.classification,
    plannedAction: row.plannedAction,
    status: row.status,
    targetEntityId: row.targetEntityId,
    errorCode: row.errorCode,
    issues: issuesFromUnknown(row.issues),
  };
}

async function summaryWithin(
  tx: TransactionClient,
  tenant: string,
  jobId: string,
): Promise<OpeningInventoryImportSummary | null> {
  const job = await tx.migrationImportJob.findFirst({
    where: { tenantId: tenant, id: jobId },
  });
  if (job === null) return null;
  if (job.domain !== 'opening-inventory' || (job.format !== 'csv' && job.format !== 'xlsx')) {
    throw new DatabaseError('Opening inventory import job carries unsupported domain/format.');
  }
  if (
    job.status !== 'reviewed' &&
    job.status !== 'dry-run' &&
    job.status !== 'committing' &&
    job.status !== 'completed'
  ) {
    throw new DatabaseError('Opening inventory import job carries unknown lifecycle status.');
  }

  const [previewRows, statusCounts] = await Promise.all([
    tx.migrationImportRow.findMany({
      where: { tenantId: tenant, jobId },
      select: {
        sourceRow: true,
        sourceIdentifier: true,
        classification: true,
        plannedAction: true,
        status: true,
        targetEntityId: true,
        errorCode: true,
        issues: true,
      },
      orderBy: [{ sourceRow: 'asc' }, { id: 'asc' }],
      take: SUMMARY_ROW_PREVIEW_LIMIT,
    }),
    tx.migrationImportRow.groupBy({
      by: ['status'],
      where: { tenantId: tenant, jobId },
      _count: { _all: true },
    }),
  ]);
  const count = (status: string) =>
    statusCounts.find((entry) => entry.status === status)?._count._all ?? 0;
  const rows = previewRows.map(openingInventoryRowResult);

  return {
    id: job.id,
    domain: 'opening-inventory',
    format: job.format,
    sourceFileName: job.sourceFileName,
    sourceSystem: job.sourceSystem,
    sourceSha256: job.sourceSha256,
    status: job.status,
    mappingVersion: job.mappingVersion,
    mapping: mappingFromUnknown(job.mapping),
    conflictPolicy: 'reject',
    totalRows: job.totalRows,
    validRows: job.validRows,
    warningRows: job.warningRows,
    errorRows: job.errorRows,
    blockedRows: job.blockedRows,
    created: count('committed'),
    failed: count('failed'),
    rejected: count('rejected'),
    rows,
    rowsTruncated: job.totalRows > rows.length,
    createdAt: job.createdAt.toISOString(),
    dryRunAt: job.dryRunAt?.toISOString() ?? null,
    commitAt: job.commitAt?.toISOString() ?? null,
  };
}

async function clearSourceData(
  tx: TransactionClient,
  tenant: string,
  jobId: string,
  rowId: string | null,
): Promise<void> {
  if (rowId === null) {
    await tx.$executeRaw`
      UPDATE "migration_import_rows"
         SET "sourceData" = NULL
       WHERE "tenantId" = ${tenant}::uuid AND "jobId" = ${jobId}::uuid`;
    return;
  }
  await tx.$executeRaw`
    UPDATE "migration_import_rows"
       SET "sourceData" = NULL
     WHERE "tenantId" = ${tenant}::uuid
       AND "jobId" = ${jobId}::uuid
       AND "id" = ${rowId}::uuid`;
}

export async function readOpeningInventoryImportRows(
  prisma: PrismaClient,
  scope: TenantScope,
  jobId: string,
  options: {
    readonly limit: number;
    readonly afterSourceRow: number | null;
    readonly problemsOnly: boolean;
  },
): Promise<OpeningInventoryImportRowPage | null> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new OpeningInventoryImportRefusedError('invalid-operation');
  }
  if (
    options.afterSourceRow !== null &&
    (!Number.isInteger(options.afterSourceRow) || options.afterSourceRow < 1)
  ) {
    throw new OpeningInventoryImportRefusedError('invalid-operation');
  }

  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'opening-inventory' },
      select: { id: true },
    });
    if (job === null) return null;

    const rows = await tx.migrationImportRow.findMany({
      where: {
        tenantId: tenant,
        jobId,
        ...(options.afterSourceRow === null ? {} : { sourceRow: { gt: options.afterSourceRow } }),
        ...(options.problemsOnly
          ? {
              OR: [
                { classification: { in: ['WARNING', 'ERROR', 'BLOCKED'] } },
                { status: { in: ['rejected', 'failed'] } },
              ],
            }
          : {}),
      },
      select: {
        sourceRow: true,
        sourceIdentifier: true,
        classification: true,
        plannedAction: true,
        status: true,
        targetEntityId: true,
        errorCode: true,
        issues: true,
      },
      orderBy: [{ sourceRow: 'asc' }, { id: 'asc' }],
      take: options.limit + 1,
    });
    const hasMore = rows.length > options.limit;
    const pageRows = rows.slice(0, options.limit);
    return {
      rows: pageRows.map(openingInventoryRowResult),
      nextAfterSourceRow:
        hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]!.sourceRow : null,
    };
  });
}

export async function createOpeningInventoryImportJob(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: OpeningInventoryImportActor,
  request: CreateOpeningInventoryImportJobRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<OpeningInventoryImportSummary> {
  if (!validSha256(request.sourceSha256)) {
    throw new OpeningInventoryImportRefusedError('invalid-source-hash');
  }
  if (request.sheet.rows[0] === undefined) {
    throw new OpeningInventoryImportRefusedError('invalid-operation');
  }

  const reviews = reviewOpeningInventorySheet(request.sheet, request.mapping);
  const counts = summarizeImportReviews(reviews);
  const sourceRows = request.sheet.rows.slice(1);
  const rowFingerprints = sourceRows.map((row, index) =>
    sha256({
      sourceRow:
        reviews[index]?.sourceRow ?? request.sheet.sourceRowNumbers?.[index + 1] ?? index + 2,
      cells: row,
    }),
  );
  const requestHash = sha256({
    sourceSha256: request.sourceSha256,
    format: request.format,
    sourceFileName: request.sourceFileName,
    sourceSystem: request.sourceSystem,
    mapping: request.mapping,
    rowFingerprints,
  });
  const tenant = tenantParam(scope);
  const jobId = nextId();
  const at = clock();

  try {
    return await withTenant(prisma, scope.tenantId, async (tx) => {
      const existing = await tx.migrationImportJob.findFirst({
        where: { tenantId: tenant, createOperationId: request.operationId },
        select: { id: true, createRequestHash: true, domain: true },
      });
      if (existing !== null) {
        if (existing.createRequestHash !== requestHash || existing.domain !== 'opening-inventory') {
          throw new OpeningInventoryImportRefusedError('idempotency-conflict');
        }
        const replay = await summaryWithin(tx, tenant, existing.id);
        if (replay === null)
          throw new DatabaseError('Opening inventory import replay disappeared.');
        return replay;
      }

      await tx.migrationImportJob.create({
        data: {
          id: jobId,
          tenantId: tenant,
          actorUserId: actor.userId,
          domain: 'opening-inventory',
          format: request.format,
          sourceFileName: request.sourceFileName,
          sourceSystem: request.sourceSystem,
          sourceSha256: request.sourceSha256,
          createOperationId: request.operationId,
          createRequestHash: requestHash,
          commitOperationId: null,
          status: 'reviewed',
          mappingVersion: 1,
          mapping: jsonObject(request.mapping),
          conflictPolicy: 'reject',
          ...counts,
          createdAt: at,
          updatedAt: at,
        },
      });

      for (let offset = 0; offset < reviews.length; offset += ROW_BATCH) {
        const batch = reviews.slice(offset, offset + ROW_BATCH);
        await tx.migrationImportRow.createMany({
          data: batch.map((review, index) => {
            const absoluteIndex = offset + index;
            const rejected =
              review.classification === 'ERROR' || review.classification === 'BLOCKED';
            return {
              id: nextId(),
              tenantId: tenant,
              jobId,
              sourceRow: review.sourceRow,
              rowFingerprint: rowFingerprints[absoluteIndex]!,
              sourceIdentifier:
                review.record === null
                  ? null
                  : review.record.branchCode + ' / ' + review.record.sku,
              sourceData: jsonObject(sourceRows[absoluteIndex] ?? []),
              ...(review.record === null ? {} : { canonicalData: jsonObject(review.record) }),
              issues: jsonObject(review.issues),
              classification: review.classification,
              plannedAction: rejected ? 'reject' : 'create',
              status: rejected ? 'rejected' : 'pending',
              targetEntityId: null,
              errorCode: null,
              createdAt: at,
              updatedAt: at,
            };
          }),
        });
      }

      await tx.auditEvent.create({
        data: {
          id: nextId(),
          tenantId: tenant,
          actorUserId: actor.userId,
          branchId: null,
          terminalId: null,
          eventType: 'migration.opening-inventory.review-created',
          entityType: 'migration-import-job',
          entityId: jobId,
          metadata: { format: request.format, sourceSha256: request.sourceSha256, ...counts },
          occurredAt: at,
        },
      });

      const result = await summaryWithin(tx, tenant, jobId);
      if (result === null)
        throw new DatabaseError('Opening inventory import job could not be read back.');
      return result;
    });
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    return withTenant(prisma, scope.tenantId, async (tx) => {
      const existing = await tx.migrationImportJob.findFirst({
        where: { tenantId: tenant, createOperationId: request.operationId },
        select: { id: true, createRequestHash: true, domain: true },
      });
      if (
        existing === null ||
        existing.createRequestHash !== requestHash ||
        existing.domain !== 'opening-inventory'
      ) {
        throw new OpeningInventoryImportRefusedError('idempotency-conflict');
      }
      const replay = await summaryWithin(tx, tenant, existing.id);
      if (replay === null)
        throw new DatabaseError('Opening inventory import replay could not be read.');
      return replay;
    });
  }
}

export async function readOpeningInventoryImportJob(
  prisma: PrismaClient,
  scope: TenantScope,
  jobId: string,
): Promise<OpeningInventoryImportSummary | null> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, (tx) => summaryWithin(tx, tenant, jobId));
}

export async function dryRunOpeningInventoryImport(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: OpeningInventoryImportActor,
  jobId: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<OpeningInventoryImportSummary> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'opening-inventory' },
      select: { id: true, status: true },
    });
    if (job === null) throw new OpeningInventoryImportRefusedError('unknown-job');
    if (job.status !== 'reviewed') {
      const existing = await summaryWithin(tx, tenant, jobId);
      if (existing === null) throw new OpeningInventoryImportRefusedError('unknown-job');
      return existing;
    }

    const rows = await tx.migrationImportRow.findMany({
      where: { tenantId: tenant, jobId, status: 'pending', plannedAction: 'create' },
      orderBy: { sourceRow: 'asc' },
    });
    for (const row of rows) {
      const canonical = canonicalFromUnknown(row.canonicalData);
      try {
        const identity = await resolveOpeningIdentityWithin(tx, tenant, canonical);
        await assertPristineOpeningBalanceWithin(tx, tenant, identity.branchId, identity.productId);
      } catch (error) {
        if (!(error instanceof OpeningInventoryRowRefusedError)) throw error;
        const issues = [
          ...issuesFromUnknown(row.issues),
          openingIssue(row.sourceRow, error.detail),
        ];
        await tx.migrationImportRow.update({
          where: { id: row.id },
          data: {
            issues: jsonObject(issues),
            classification: 'ERROR',
            plannedAction: 'reject',
            status: 'rejected',
            errorCode: error.detail,
          },
        });
      }
    }

    const allRows = await tx.migrationImportRow.findMany({
      where: { tenantId: tenant, jobId },
      select: { classification: true },
    });
    const counts = {
      totalRows: allRows.length,
      validRows: 0,
      warningRows: 0,
      errorRows: 0,
      blockedRows: 0,
    };
    for (const row of allRows) {
      if (row.classification === 'VALID') counts.validRows += 1;
      else if (row.classification === 'WARNING') counts.warningRows += 1;
      else if (row.classification === 'ERROR') counts.errorRows += 1;
      else if (row.classification === 'BLOCKED') counts.blockedRows += 1;
      else throw new DatabaseError('Opening inventory import row classification is corrupt.');
    }

    const at = clock();
    await tx.migrationImportJob.update({
      where: { id: jobId },
      data: { status: 'dry-run', ...counts, dryRunAt: at, updatedAt: at },
    });
    await tx.auditEvent.create({
      data: {
        id: nextId(),
        tenantId: tenant,
        actorUserId: actor.userId,
        branchId: null,
        terminalId: null,
        eventType: 'migration.opening-inventory.dry-run',
        entityType: 'migration-import-job',
        entityId: jobId,
        metadata: {
          ...counts,
          conflictPolicy: 'reject',
          identityResolution: 'server-tenant-scoped-branchCode+sku',
          costAuthority: 'unknown',
        },
        occurredAt: at,
      },
    });

    const result = await summaryWithin(tx, tenant, jobId);
    if (result === null) throw new OpeningInventoryImportRefusedError('unknown-job');
    return result;
  });
}

async function processPendingOpeningInventoryRow(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: OpeningInventoryImportActor,
  jobId: string,
  rowId: string,
  clock: () => Date,
  nextId: () => string,
): Promise<void> {
  const tenant = tenantParam(scope);
  await withTenant(prisma, scope.tenantId, async (tx) => {
    const claimed = await tx.migrationImportRow.updateMany({
      where: {
        id: rowId,
        tenantId: tenant,
        jobId,
        status: 'pending',
        plannedAction: 'create',
      },
      data: { status: 'committing' },
    });
    if (claimed.count !== 1) return;

    const row = await tx.migrationImportRow.findFirst({
      where: { id: rowId, tenantId: tenant, jobId },
    });
    if (row === null) throw new DatabaseError('Claimed opening inventory import row disappeared.');
    const canonical = canonicalFromUnknown(row.canonicalData);
    const at = clock();

    await tx.$executeRawUnsafe('SAVEPOINT korvi_opening_inventory_import_row');
    try {
      const identity = await resolveOpeningIdentityWithin(tx, tenant, canonical);
      await lockBranches(tx, tenant, [identity.branchId]);
      const productFacts = await lockProducts(tx, tenant, [identity.productId]);
      const fact = productFacts.get(identity.productId);
      if (fact === undefined) throw new OpeningInventoryRowRefusedError('unknown-product');
      try {
        assertQuantityShape(BigInt(canonical.quantityScaled), fact.productType, 'openingQuantity');
      } catch {
        throw new OpeningInventoryRowRefusedError('invalid-quantity-shape');
      }
      const balances = await lockBalances(tx, tenant, [
        { branchId: identity.branchId, productId: identity.productId },
      ]);
      const before = lockedOrThrow(balances, {
        branchId: identity.branchId,
        productId: identity.productId,
      });
      if (before.quantityScaled !== 0n || before.revision !== 0n) {
        throw new OpeningInventoryRowRefusedError('opening-stock-not-pristine');
      }

      const movementId = nextId();
      const applied = await applyMovementWithin(
        tx,
        tenant,
        {
          id: movementId,
          branchId: identity.branchId,
          productId: identity.productId,
          kind: 'adjustment',
          quantityScaled: canonical.quantityScaled,
          reason: 'Opening inventory migration',
          sourceType: 'migration-opening-stock',
          sourceId: jobId,
          actorUserId: actor.userId,
          occurredAt: at.toISOString(),
        },
        true,
        row.id,
      );
      if (applied.quantityScaled !== BigInt(canonical.quantityScaled) || applied.revision !== 1n) {
        throw new DatabaseError('Opening inventory movement produced an invalid postcondition.');
      }

      await tx.$executeRawUnsafe('RELEASE SAVEPOINT korvi_opening_inventory_import_row');
      await tx.migrationImportRow.update({
        where: { id: row.id },
        data: {
          status: 'committed',
          targetEntityId: movementId,
          errorCode: null,
          updatedAt: at,
        },
      });
      await clearSourceData(tx, tenant, jobId, row.id);
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT korvi_opening_inventory_import_row');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT korvi_opening_inventory_import_row');

      let detail: OpeningInventoryRowRefusedError['detail'] | null = null;
      if (error instanceof OpeningInventoryRowRefusedError) detail = error.detail;
      if (error instanceof StockOperationRefusedError) {
        if (
          error.detail === 'unknown-branch' ||
          error.detail === 'inactive-branch' ||
          error.detail === 'unknown-product' ||
          error.detail === 'inactive-product' ||
          error.detail === 'untracked-product'
        ) {
          detail = error.detail;
        }
      }
      if (detail === null) throw error;

      const issues = [...issuesFromUnknown(row.issues), openingIssue(row.sourceRow, detail)];
      await tx.migrationImportRow.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          plannedAction: 'reject',
          classification: 'ERROR',
          issues: jsonObject(issues),
          errorCode: detail,
          updatedAt: at,
        },
      });
      await clearSourceData(tx, tenant, jobId, row.id);
    }
  });
}

export async function commitOpeningInventoryImport(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: OpeningInventoryImportActor,
  jobId: string,
  operationId: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<OpeningInventoryImportSummary> {
  const tenant = tenantParam(scope);

  await withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'opening-inventory' },
      select: { status: true, commitOperationId: true },
    });
    if (job === null) throw new OpeningInventoryImportRefusedError('unknown-job');
    if (job.commitOperationId !== null && job.commitOperationId !== operationId) {
      throw new OpeningInventoryImportRefusedError('idempotency-conflict');
    }
    if (job.status === 'completed') return;
    if (job.status !== 'dry-run' && job.status !== 'committing') {
      throw new OpeningInventoryImportRefusedError('job-not-ready');
    }
    if (job.status === 'dry-run') {
      const claimed = await tx.migrationImportJob.updateMany({
        where: { tenantId: tenant, id: jobId, status: 'dry-run', commitOperationId: null },
        data: { status: 'committing', commitOperationId: operationId },
      });
      if (claimed.count !== 1) {
        const current = await tx.migrationImportJob.findFirst({
          where: { tenantId: tenant, id: jobId },
          select: { commitOperationId: true },
        });
        if (current?.commitOperationId !== operationId) {
          throw new OpeningInventoryImportRefusedError('idempotency-conflict');
        }
      }
    }
  });

  while (true) {
    const ids = await withTenant(prisma, scope.tenantId, (tx) =>
      tx.migrationImportRow.findMany({
        where: { tenantId: tenant, jobId, status: 'pending', plannedAction: 'create' },
        select: { id: true },
        orderBy: { sourceRow: 'asc' },
        take: ROW_BATCH,
      }),
    );
    if (ids.length === 0) break;
    for (const row of ids) {
      await processPendingOpeningInventoryRow(prisma, scope, actor, jobId, row.id, clock, nextId);
    }
  }

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'opening-inventory' },
      select: { status: true, commitOperationId: true },
    });
    if (job === null) throw new OpeningInventoryImportRefusedError('unknown-job');
    if (job.commitOperationId !== operationId) {
      throw new OpeningInventoryImportRefusedError('idempotency-conflict');
    }

    if (job.status !== 'completed') {
      const counts = await tx.migrationImportRow.groupBy({
        by: ['status'],
        where: { tenantId: tenant, jobId },
        _count: { _all: true },
      });
      const count = (status: string) =>
        counts.find((entry) => entry.status === status)?._count._all ?? 0;
      const at = clock();
      await clearSourceData(tx, tenant, jobId, null);
      await tx.migrationImportJob.update({
        where: { id: jobId },
        data: { status: 'completed', commitAt: at, updatedAt: at },
      });
      await tx.auditEvent.create({
        data: {
          id: nextId(),
          tenantId: tenant,
          actorUserId: actor.userId,
          branchId: null,
          terminalId: null,
          eventType: 'migration.opening-inventory.completed',
          entityType: 'migration-import-job',
          entityId: jobId,
          metadata: {
            created: count('committed'),
            failed: count('failed'),
            rejected: count('rejected'),
            movementSourceType: 'migration-opening-stock',
            costAuthority: 'unknown',
          },
          occurredAt: at,
        },
      });
    }

    const result = await summaryWithin(tx, tenant, jobId);
    if (result === null) throw new OpeningInventoryImportRefusedError('unknown-job');
    return result;
  });
}
