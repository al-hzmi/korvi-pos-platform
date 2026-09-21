import { createHash } from 'node:crypto';
import {
  classifyImportIssues,
  newId,
  reviewCategorySheet,
  summarizeImportReviews,
} from '@korvi/domain';
import {
  CategoryBootstrapRefusedError,
  ensureCategoryWithin,
} from '../administration/category-bootstrap.js';
import { DatabaseError } from '../errors.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type {
  CanonicalCategoryImportRow,
  CategoryColumnMapping,
  CategoryImportField,
  ImportClassification,
  ImportIssue,
  ImportSheet,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const ROW_BATCH = 200;
const SUMMARY_ROW_PREVIEW_LIMIT = 50;

export type CategoryImportRefusal =
  | 'unknown-job'
  | 'invalid-source-hash'
  | 'invalid-operation'
  | 'idempotency-conflict'
  | 'job-not-ready';

export class CategoryImportRefusedError extends DatabaseError {
  public override readonly name = 'CategoryImportRefusedError';

  public constructor(public readonly detail: CategoryImportRefusal) {
    super('Category import refused: ' + detail);
  }
}

export interface CategoryImportActor {
  readonly userId: string;
}

export interface CreateCategoryImportJobRequest {
  readonly operationId: string;
  readonly sourceSha256: string;
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sheet: ImportSheet;
  readonly mapping: readonly CategoryColumnMapping[];
}

export interface CategoryImportRowResult {
  readonly sourceRow: number;
  readonly sourceIdentifier: string | null;
  readonly classification: ImportClassification;
  readonly plannedAction: 'create' | 'reject';
  readonly status: 'pending' | 'committing' | 'rejected' | 'committed' | 'failed';
  readonly targetEntityId: string | null;
  readonly errorCode: string | null;
  readonly issues: readonly ImportIssue[];
}

export interface CategoryImportRowPage {
  readonly rows: readonly CategoryImportRowResult[];
  readonly nextAfterSourceRow: number | null;
}

export interface CategoryImportSummary {
  readonly id: string;
  readonly domain: 'categories';
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceSha256: string;
  readonly status: 'reviewed' | 'dry-run' | 'committing' | 'completed';
  readonly mappingVersion: number;
  readonly mapping: readonly CategoryColumnMapping[];
  readonly conflictPolicy: 'reject';
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
  readonly created: number;
  readonly failed: number;
  readonly rejected: number;
  readonly rows: readonly CategoryImportRowResult[];
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

function mappingFromUnknown(value: unknown): CategoryColumnMapping[] {
  if (!Array.isArray(value)) throw new DatabaseError('Category import mapping is corrupt.');
  const fields = new Set<CategoryImportField>(['nameAr', 'nameEn', 'sortOrder']);
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DatabaseError('Category import mapping is corrupt.');
    }
    const candidate = entry as Record<string, unknown>;
    if (!Number.isInteger(candidate.sourceColumn) || (candidate.sourceColumn as number) < 0) {
      throw new DatabaseError('Category import mapping is corrupt.');
    }
    const target = candidate.targetField;
    if (
      target !== null &&
      (typeof target !== 'string' || !fields.has(target as CategoryImportField))
    ) {
      throw new DatabaseError('Category import mapping is corrupt.');
    }
    return {
      sourceColumn: candidate.sourceColumn as number,
      targetField: target as CategoryImportField | null,
    };
  });
}

function canonicalFromUnknown(value: unknown): CanonicalCategoryImportRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatabaseError('Category import canonical row is missing.');
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.nameAr !== 'string' ||
    (row.nameEn !== null && typeof row.nameEn !== 'string') ||
    !Number.isInteger(row.sortOrder)
  ) {
    throw new DatabaseError('Category import canonical row is corrupt.');
  }
  return {
    nameAr: row.nameAr,
    nameEn: row.nameEn as string | null,
    sortOrder: row.sortOrder as number,
  };
}

function conflictIssue(sourceRow: number): ImportIssue {
  return {
    classification: 'ERROR',
    code: 'category-conflict',
    message: 'The category name already exists in this merchant catalogue.',
    row: sourceRow,
    sourceColumn: null,
    targetField: 'nameAr',
  };
}

function commitIssue(sourceRow: number, code: string, message: string): ImportIssue {
  return {
    classification: 'ERROR',
    code,
    message,
    row: sourceRow,
    sourceColumn: null,
    targetField: null,
  };
}

function categoryRowResult(row: {
  sourceRow: number;
  sourceIdentifier: string | null;
  classification: string;
  plannedAction: string;
  status: string;
  targetEntityId: string | null;
  errorCode: string | null;
  issues: unknown;
}): CategoryImportRowResult {
  if (
    row.classification !== 'VALID' &&
    row.classification !== 'WARNING' &&
    row.classification !== 'ERROR' &&
    row.classification !== 'BLOCKED'
  ) {
    throw new DatabaseError('Category import row carries unknown classification.');
  }
  if (row.plannedAction !== 'create' && row.plannedAction !== 'reject') {
    throw new DatabaseError('Category import row carries unknown action.');
  }
  if (
    row.status !== 'pending' &&
    row.status !== 'committing' &&
    row.status !== 'rejected' &&
    row.status !== 'committed' &&
    row.status !== 'failed'
  ) {
    throw new DatabaseError('Category import row carries unknown status.');
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
): Promise<CategoryImportSummary | null> {
  const job = await tx.migrationImportJob.findFirst({
    where: { tenantId: tenant, id: jobId },
  });
  if (job === null) return null;
  if (job.domain !== 'categories' || (job.format !== 'csv' && job.format !== 'xlsx')) {
    throw new DatabaseError('Category import job carries unsupported domain/format.');
  }
  if (
    job.status !== 'reviewed' &&
    job.status !== 'dry-run' &&
    job.status !== 'committing' &&
    job.status !== 'completed'
  ) {
    throw new DatabaseError('Category import job carries unknown lifecycle status.');
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
  const rows = previewRows.map(categoryRowResult);

  return {
    id: job.id,
    domain: 'categories',
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

export async function readCategoryImportRows(
  prisma: PrismaClient,
  scope: TenantScope,
  jobId: string,
  options: {
    readonly limit: number;
    readonly afterSourceRow: number | null;
    readonly problemsOnly: boolean;
  },
): Promise<CategoryImportRowPage | null> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new CategoryImportRefusedError('invalid-operation');
  }
  if (
    options.afterSourceRow !== null &&
    (!Number.isInteger(options.afterSourceRow) || options.afterSourceRow < 1)
  ) {
    throw new CategoryImportRefusedError('invalid-operation');
  }

  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'categories' },
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
      rows: pageRows.map(categoryRowResult),
      nextAfterSourceRow:
        hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]!.sourceRow : null,
    };
  });
}

export async function createCategoryImportJob(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CategoryImportActor,
  request: CreateCategoryImportJobRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<CategoryImportSummary> {
  if (!validSha256(request.sourceSha256)) {
    throw new CategoryImportRefusedError('invalid-source-hash');
  }
  if (request.sheet.rows[0] === undefined) {
    throw new CategoryImportRefusedError('invalid-operation');
  }

  const reviews = reviewCategorySheet(request.sheet, request.mapping);
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
        if (existing.createRequestHash !== requestHash || existing.domain !== 'categories') {
          throw new CategoryImportRefusedError('idempotency-conflict');
        }
        const replay = await summaryWithin(tx, tenant, existing.id);
        if (replay === null) throw new DatabaseError('Category import replay disappeared.');
        return replay;
      }

      await tx.migrationImportJob.create({
        data: {
          id: jobId,
          tenantId: tenant,
          actorUserId: actor.userId,
          domain: 'categories',
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
              sourceIdentifier: review.record?.nameAr ?? null,
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
          eventType: 'migration.category.review-created',
          entityType: 'migration-import-job',
          entityId: jobId,
          metadata: { format: request.format, sourceSha256: request.sourceSha256, ...counts },
          occurredAt: at,
        },
      });

      const result = await summaryWithin(tx, tenant, jobId);
      if (result === null) throw new DatabaseError('Category import job could not be read back.');
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
        existing.domain !== 'categories'
      ) {
        throw new CategoryImportRefusedError('idempotency-conflict');
      }
      const replay = await summaryWithin(tx, tenant, existing.id);
      if (replay === null) throw new DatabaseError('Category import replay could not be read.');
      return replay;
    });
  }
}

export async function readCategoryImportJob(
  prisma: PrismaClient,
  scope: TenantScope,
  jobId: string,
): Promise<CategoryImportSummary | null> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, (tx) => summaryWithin(tx, tenant, jobId));
}

export async function dryRunCategoryImport(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CategoryImportActor,
  jobId: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<CategoryImportSummary> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'categories' },
      select: { id: true, status: true },
    });
    if (job === null) throw new CategoryImportRefusedError('unknown-job');
    if (job.status !== 'reviewed') {
      const existing = await summaryWithin(tx, tenant, jobId);
      if (existing === null) throw new CategoryImportRefusedError('unknown-job');
      return existing;
    }

    const rows = await tx.migrationImportRow.findMany({
      where: { tenantId: tenant, jobId, status: 'pending', plannedAction: 'create' },
      orderBy: { sourceRow: 'asc' },
    });
    for (const row of rows) {
      const canonical = canonicalFromUnknown(row.canonicalData);
      const exists = await tx.category.findFirst({
        where: { tenantId: tenant, nameAr: canonical.nameAr },
        select: { id: true },
      });
      if (exists !== null) {
        const issues = [...issuesFromUnknown(row.issues), conflictIssue(row.sourceRow)];
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
      else throw new DatabaseError('Category import row classification is corrupt.');
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
        eventType: 'migration.category.dry-run',
        entityType: 'migration-import-job',
        entityId: jobId,
        metadata: { ...counts, conflictPolicy: 'reject' },
        occurredAt: at,
      },
    });

    const result = await summaryWithin(tx, tenant, jobId);
    if (result === null) throw new CategoryImportRefusedError('unknown-job');
    return result;
  });
}

class CategoryCommitConflictError extends Error {
  public override readonly name = 'CategoryCommitConflictError';
}

async function processPendingCategoryRow(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CategoryImportActor,
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
    if (row === null) throw new DatabaseError('Claimed category import row disappeared.');
    const canonical = canonicalFromUnknown(row.canonicalData);
    const at = clock();

    await tx.$executeRawUnsafe('SAVEPOINT korvi_category_import_row');
    try {
      const result = await ensureCategoryWithin(tx, tenant, actor, canonical, at, nextId);
      if (!result.created) throw new CategoryCommitConflictError();
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT korvi_category_import_row');
      await tx.migrationImportRow.update({
        where: { id: row.id },
        data: {
          status: 'committed',
          targetEntityId: result.category.id,
          errorCode: null,
          updatedAt: at,
        },
      });
      await clearSourceData(tx, tenant, jobId, row.id);
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT korvi_category_import_row');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT korvi_category_import_row');

      let errorCode: string;
      let issue: ImportIssue;
      if (error instanceof CategoryCommitConflictError) {
        errorCode = 'category-conflict';
        issue = conflictIssue(row.sourceRow);
      } else if (error instanceof CategoryBootstrapRefusedError) {
        errorCode = error.detail;
        issue = commitIssue(
          row.sourceRow,
          'commit-' + error.detail,
          'The row was refused by the authoritative category writer during commit.',
        );
      } else {
        throw error;
      }

      const issues = [...issuesFromUnknown(row.issues), issue];
      await tx.migrationImportRow.update({
        where: { id: row.id },
        data: {
          status: 'failed',
          plannedAction: 'reject',
          classification: 'ERROR',
          issues: jsonObject(issues),
          errorCode,
          updatedAt: at,
        },
      });
      await clearSourceData(tx, tenant, jobId, row.id);
    }
  });
}

export async function commitCategoryImport(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CategoryImportActor,
  jobId: string,
  operationId: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<CategoryImportSummary> {
  const tenant = tenantParam(scope);

  await withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'categories' },
      select: { status: true, commitOperationId: true },
    });
    if (job === null) throw new CategoryImportRefusedError('unknown-job');
    if (job.commitOperationId !== null && job.commitOperationId !== operationId) {
      throw new CategoryImportRefusedError('idempotency-conflict');
    }
    if (job.status === 'completed') return;
    if (job.status !== 'dry-run' && job.status !== 'committing') {
      throw new CategoryImportRefusedError('job-not-ready');
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
          throw new CategoryImportRefusedError('idempotency-conflict');
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
      await processPendingCategoryRow(prisma, scope, actor, jobId, row.id, clock, nextId);
    }
  }

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'categories' },
      select: { status: true, commitOperationId: true },
    });
    if (job === null) throw new CategoryImportRefusedError('unknown-job');
    if (job.commitOperationId !== operationId) {
      throw new CategoryImportRefusedError('idempotency-conflict');
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
          eventType: 'migration.category.completed',
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
    if (result === null) throw new CategoryImportRefusedError('unknown-job');
    return result;
  });
}
