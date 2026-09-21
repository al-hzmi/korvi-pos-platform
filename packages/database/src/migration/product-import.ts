import { createHash } from 'node:crypto';
import {
  classifyImportIssues,
  newId,
  reviewProductSheet,
  summarizeImportReviews,
} from '@korvi/domain';
import {
  ProductBootstrapRefusedError,
  createBootstrapProductWithin,
} from '../administration/product-bootstrap.js';
import { DatabaseError } from '../errors.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type {
  CanonicalProductImportRow,
  ImportClassification,
  ImportIssue,
  ImportSheet,
  ProductBootstrapDraft,
  ProductColumnMapping,
  ProductImportField,
  TenantScope,
} from '@korvi/domain';
import type {
  AdminProductBootstrap,
  ProductBootstrapRefusal,
} from '../administration/product-bootstrap.js';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const ROW_BATCH = 250;
const SUMMARY_ROW_PREVIEW_LIMIT = 200;

export type ProductImportRefusal =
  | 'unknown-job'
  | 'invalid-source-hash'
  | 'invalid-operation'
  | 'idempotency-conflict'
  | 'job-not-ready';

export class ProductImportRefusedError extends DatabaseError {
  public override readonly name = 'ProductImportRefusedError';

  public constructor(public readonly detail: ProductImportRefusal) {
    super('Product import refused: ' + detail);
  }
}

export interface ProductImportActor {
  readonly userId: string;
}

export interface CreateProductImportJobRequest {
  readonly operationId: string;
  readonly sourceSha256: string;
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sheet: ImportSheet;
  readonly mapping: readonly ProductColumnMapping[];
}

export interface ProductImportRowResult {
  readonly sourceRow: number;
  readonly sourceIdentifier: string | null;
  readonly classification: ImportClassification;
  readonly plannedAction: 'create' | 'reject';
  readonly status: 'pending' | 'committing' | 'rejected' | 'committed' | 'failed';
  readonly targetEntityId: string | null;
  readonly errorCode: string | null;
  readonly issues: readonly ImportIssue[];
}

export interface ProductImportRowPage {
  readonly rows: readonly ProductImportRowResult[];
  readonly nextAfterSourceRow: number | null;
}

export interface ProductImportSummary {
  readonly id: string;
  readonly domain: 'products';
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceSha256: string;
  readonly status: 'reviewed' | 'dry-run' | 'committing' | 'completed';
  readonly mappingVersion: number;
  readonly mapping: readonly ProductColumnMapping[];
  readonly conflictPolicy: 'reject';
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
  readonly created: number;
  readonly failed: number;
  readonly rejected: number;
  /** Bounded preview only. Use the paginated row endpoint for complete result/error export. */
  readonly rows: readonly ProductImportRowResult[];
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

function mappingFromUnknown(value: unknown): ProductColumnMapping[] {
  if (!Array.isArray(value)) throw new DatabaseError('Product import mapping is corrupt.');
  const result: ProductColumnMapping[] = [];
  const fields = new Set<ProductImportField>([
    'sku',
    'barcode',
    'nameAr',
    'nameEn',
    'productType',
    'unitLabel',
    'sellingPrice',
    'vatRate',
  ]);
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DatabaseError('Product import mapping is corrupt.');
    }
    const candidate = entry as Record<string, unknown>;
    if (!Number.isInteger(candidate.sourceColumn) || (candidate.sourceColumn as number) < 0) {
      throw new DatabaseError('Product import mapping is corrupt.');
    }
    const target = candidate.targetField;
    if (
      target !== null &&
      (typeof target !== 'string' || !fields.has(target as ProductImportField))
    ) {
      throw new DatabaseError('Product import mapping is corrupt.');
    }
    result.push({
      sourceColumn: candidate.sourceColumn as number,
      targetField: target as ProductImportField | null,
    });
  }
  return result;
}

function canonicalFromUnknown(value: unknown): CanonicalProductImportRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatabaseError('Product import canonical row is missing.');
  }
  const row = value as Record<string, unknown>;
  const productType = row.productType;
  if (
    typeof row.sku !== 'string' ||
    typeof row.nameAr !== 'string' ||
    (row.nameEn !== null && typeof row.nameEn !== 'string') ||
    (row.barcode !== null && typeof row.barcode !== 'string') ||
    (productType !== 'unit' && productType !== 'weighted') ||
    typeof row.unitLabel !== 'string' ||
    typeof row.priceMinor !== 'string' ||
    (row.vatBasisPoints !== undefined && typeof row.vatBasisPoints !== 'number')
  ) {
    throw new DatabaseError('Product import canonical row is corrupt.');
  }
  return {
    sku: row.sku,
    barcode: row.barcode as string | null,
    nameAr: row.nameAr,
    nameEn: row.nameEn as string | null,
    productType,
    unitLabel: row.unitLabel,
    priceMinor: row.priceMinor,
    vatBasisPoints: row.vatBasisPoints === undefined ? undefined : (row.vatBasisPoints as number),
  };
}

function bootstrapDraft(row: CanonicalProductImportRow): ProductBootstrapDraft {
  return {
    sku: row.sku,
    barcode: row.barcode,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    productType: row.productType,
    unitLabel: row.unitLabel,
    priceMinor: row.priceMinor,
    ...(row.vatBasisPoints === undefined ? {} : { vatBasisPoints: row.vatBasisPoints }),
  };
}

function conflictIssue(
  sourceRow: number,
  field: 'sku' | 'barcode',
  code: 'sku-conflict' | 'barcode-conflict',
): ImportIssue {
  return {
    classification: 'ERROR',
    code,
    message: `The ${field} already exists in this merchant catalogue.`,
    row: sourceRow,
    sourceColumn: null,
    targetField: field,
  };
}

function commitIssue(sourceRow: number, refusal: ProductBootstrapRefusal): ImportIssue {
  return {
    classification: 'ERROR',
    code: 'commit-' + refusal,
    message: 'The row was refused by the authoritative product writer during commit.',
    row: sourceRow,
    sourceColumn: null,
    targetField: null,
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

async function productRowResult(row: {
  sourceRow: number;
  sourceIdentifier: string | null;
  classification: string;
  plannedAction: string;
  status: string;
  targetEntityId: string | null;
  errorCode: string | null;
  issues: unknown;
}): Promise<ProductImportRowResult> {
  if (
    row.classification !== 'VALID' &&
    row.classification !== 'WARNING' &&
    row.classification !== 'ERROR' &&
    row.classification !== 'BLOCKED'
  ) {
    throw new DatabaseError('Product import row carries unknown classification.');
  }
  if (row.plannedAction !== 'create' && row.plannedAction !== 'reject') {
    throw new DatabaseError('Product import row carries unknown action.');
  }
  if (
    row.status !== 'pending' &&
    row.status !== 'committing' &&
    row.status !== 'rejected' &&
    row.status !== 'committed' &&
    row.status !== 'failed'
  ) {
    throw new DatabaseError('Product import row carries unknown status.');
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
): Promise<ProductImportSummary | null> {
  const job = await tx.migrationImportJob.findFirst({
    where: { tenantId: tenant, id: jobId },
  });
  if (job === null) return null;
  if (job.domain !== 'products' || (job.format !== 'csv' && job.format !== 'xlsx')) {
    throw new DatabaseError('Product import job carries unsupported domain/format.');
  }
  if (
    job.status !== 'reviewed' &&
    job.status !== 'dry-run' &&
    job.status !== 'committing' &&
    job.status !== 'completed'
  ) {
    throw new DatabaseError('Product import job carries unknown lifecycle status.');
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
  const rows = await Promise.all(previewRows.map(productRowResult));

  return {
    id: job.id,
    domain: 'products',
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

export async function readProductImportRows(
  prisma: PrismaClient,
  scope: TenantScope,
  jobId: string,
  options: {
    readonly limit: number;
    readonly afterSourceRow: number | null;
    readonly problemsOnly: boolean;
  },
): Promise<ProductImportRowPage | null> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new ProductImportRefusedError('invalid-operation');
  }
  if (
    options.afterSourceRow !== null &&
    (!Number.isInteger(options.afterSourceRow) || options.afterSourceRow < 1)
  ) {
    throw new ProductImportRefusedError('invalid-operation');
  }

  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'products' },
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
      rows: await Promise.all(pageRows.map(productRowResult)),
      nextAfterSourceRow:
        hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]!.sourceRow : null,
    };
  });
}

export async function createProductImportJob(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: ProductImportActor,
  request: CreateProductImportJobRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<ProductImportSummary> {
  if (!validSha256(request.sourceSha256)) {
    throw new ProductImportRefusedError('invalid-source-hash');
  }
  if (request.sheet.rows[0] === undefined) {
    throw new ProductImportRefusedError('invalid-operation');
  }

  const reviews = reviewProductSheet(request.sheet, request.mapping);
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
        select: { id: true, createRequestHash: true },
      });
      if (existing !== null) {
        if (existing.createRequestHash !== requestHash) {
          throw new ProductImportRefusedError('idempotency-conflict');
        }
        const replay = await summaryWithin(tx, tenant, existing.id);
        if (replay === null) throw new DatabaseError('Product import replay disappeared.');
        return replay;
      }

      await tx.migrationImportJob.create({
        data: {
          id: jobId,
          tenantId: tenant,
          actorUserId: actor.userId,
          domain: 'products',
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
            const sourceData = sourceRows[absoluteIndex] ?? [];
            const rejected =
              review.classification === 'ERROR' || review.classification === 'BLOCKED';
            return {
              id: nextId(),
              tenantId: tenant,
              jobId,
              sourceRow: review.sourceRow,
              rowFingerprint: rowFingerprints[absoluteIndex]!,
              sourceIdentifier: review.record?.sku ?? null,
              sourceData: jsonObject(sourceData),
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
          eventType: 'migration.product.review-created',
          entityType: 'migration-import-job',
          entityId: jobId,
          metadata: {
            format: request.format,
            sourceSha256: request.sourceSha256,
            totalRows: counts.totalRows,
            validRows: counts.validRows,
            warningRows: counts.warningRows,
            errorRows: counts.errorRows,
            blockedRows: counts.blockedRows,
          },
          occurredAt: at,
        },
      });

      const result = await summaryWithin(tx, tenant, jobId);
      if (result === null) throw new DatabaseError('Product import job could not be read back.');
      return result;
    });
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    return withTenant(prisma, scope.tenantId, async (tx) => {
      const existing = await tx.migrationImportJob.findFirst({
        where: { tenantId: tenant, createOperationId: request.operationId },
        select: { id: true, createRequestHash: true },
      });
      if (existing === null || existing.createRequestHash !== requestHash) {
        throw new ProductImportRefusedError('idempotency-conflict');
      }
      const replay = await summaryWithin(tx, tenant, existing.id);
      if (replay === null) throw new DatabaseError('Product import replay could not be read.');
      return replay;
    });
  }
}

export async function readProductImportJob(
  prisma: PrismaClient,
  scope: TenantScope,
  jobId: string,
): Promise<ProductImportSummary | null> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, (tx) => summaryWithin(tx, tenant, jobId));
}

export async function dryRunProductImport(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: ProductImportActor,
  jobId: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<ProductImportSummary> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'products' },
      select: { id: true, status: true },
    });
    if (job === null) throw new ProductImportRefusedError('unknown-job');
    if (job.status !== 'reviewed') {
      const existing = await summaryWithin(tx, tenant, jobId);
      if (existing === null) throw new ProductImportRefusedError('unknown-job');
      return existing;
    }

    const rows = await tx.migrationImportRow.findMany({
      where: { tenantId: tenant, jobId, status: 'pending', plannedAction: 'create' },
      orderBy: { sourceRow: 'asc' },
    });
    for (const row of rows) {
      const canonical = canonicalFromUnknown(row.canonicalData);
      const issues = issuesFromUnknown(row.issues);
      const skuConflict = await tx.product.findFirst({
        where: { tenantId: tenant, sku: canonical.sku },
        select: { id: true },
      });
      if (skuConflict !== null) {
        issues.push(conflictIssue(row.sourceRow, 'sku', 'sku-conflict'));
      }
      if (canonical.barcode !== null) {
        const barcodeConflict = await tx.productBarcode.findFirst({
          where: { tenantId: tenant, barcode: canonical.barcode },
          select: { id: true },
        });
        if (barcodeConflict !== null) {
          issues.push(conflictIssue(row.sourceRow, 'barcode', 'barcode-conflict'));
        }
      }
      if (
        issues.some(
          (issue) => issue.classification === 'ERROR' || issue.classification === 'BLOCKED',
        )
      ) {
        await tx.migrationImportRow.update({
          where: { id: row.id },
          data: {
            issues: jsonObject(issues),
            classification: classifyImportIssues(issues),
            plannedAction: 'reject',
            status: 'rejected',
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
      else throw new DatabaseError('Product import row classification is corrupt.');
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
        eventType: 'migration.product.dry-run',
        entityType: 'migration-import-job',
        entityId: jobId,
        metadata: { ...counts, conflictPolicy: 'reject' },
        occurredAt: at,
      },
    });
    const result = await summaryWithin(tx, tenant, jobId);
    if (result === null) throw new ProductImportRefusedError('unknown-job');
    return result;
  });
}

async function processPendingRow(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: ProductImportActor,
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
    if (row === null) throw new DatabaseError('Claimed product import row disappeared.');
    const canonical = canonicalFromUnknown(row.canonicalData);
    const at = clock();

    await tx.$executeRawUnsafe('SAVEPOINT korvi_product_import_row');
    try {
      const product: AdminProductBootstrap = await createBootstrapProductWithin(
        tx,
        tenant,
        actor,
        bootstrapDraft(canonical),
        at,
        nextId,
      );
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT korvi_product_import_row');
      await tx.migrationImportRow.update({
        where: { id: row.id },
        data: {
          status: 'committed',
          targetEntityId: product.id,
          errorCode: null,
          updatedAt: at,
        },
      });
      await clearSourceData(tx, tenant, jobId, row.id);
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT korvi_product_import_row');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT korvi_product_import_row');
      if (!(error instanceof ProductBootstrapRefusedError)) throw error;
      const issues = [...issuesFromUnknown(row.issues), commitIssue(row.sourceRow, error.detail)];
      await tx.migrationImportRow.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          plannedAction: 'reject',
          classification: 'ERROR',
          issues: jsonObject(issues),
          errorCode: error.detail,
          updatedAt: at,
        },
      });
      await clearSourceData(tx, tenant, jobId, row.id);
    }
  });
}

export async function commitProductImport(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: ProductImportActor,
  jobId: string,
  operationId: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<ProductImportSummary> {
  const tenant = tenantParam(scope);

  await withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'products' },
      select: { status: true, commitOperationId: true },
    });
    if (job === null) throw new ProductImportRefusedError('unknown-job');
    if (job.commitOperationId !== null && job.commitOperationId !== operationId) {
      throw new ProductImportRefusedError('idempotency-conflict');
    }
    if (job.status === 'completed') return;
    if (job.status !== 'dry-run' && job.status !== 'committing') {
      throw new ProductImportRefusedError('job-not-ready');
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
          throw new ProductImportRefusedError('idempotency-conflict');
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
      await processPendingRow(prisma, scope, actor, jobId, row.id, clock, nextId);
    }
  }

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'products' },
      select: { status: true, commitOperationId: true },
    });
    if (job === null) throw new ProductImportRefusedError('unknown-job');
    if (job.commitOperationId !== operationId) {
      throw new ProductImportRefusedError('idempotency-conflict');
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
          eventType: 'migration.product.completed',
          entityType: 'migration-import-job',
          entityId: jobId,
          metadata: {
            created: count('committed'),
            failed: count('failed'),
            rejected: count('rejected'),
          },
          occurredAt: at,
        },
      });
    }

    const result = await summaryWithin(tx, tenant, jobId);
    if (result === null) throw new ProductImportRefusedError('unknown-job');
    return result;
  });
}
