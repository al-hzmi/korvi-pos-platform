import { createHash } from 'node:crypto';
import {
  classifyImportIssues,
  newId,
  reviewCustomerSheet,
  summarizeImportReviews,
} from '@korvi/domain';
import {
  CustomerAdminRefusedError,
  createMerchantCustomerWithin,
  updateMerchantCustomerWithin,
} from '../administration/customers.js';
import { DatabaseError } from '../errors.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type {
  CanonicalCustomerImportRow,
  CustomerColumnMapping,
  CustomerImportField,
  ImportClassification,
  ImportIssue,
  ImportSheet,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

const ROW_BATCH = 200;
const SUMMARY_ROW_PREVIEW_LIMIT = 50;

export type CustomerImportRefusal =
  | 'unknown-job'
  | 'invalid-source-hash'
  | 'invalid-operation'
  | 'idempotency-conflict'
  | 'job-not-ready';

export class CustomerImportRefusedError extends DatabaseError {
  public override readonly name = 'CustomerImportRefusedError';

  public constructor(public readonly detail: CustomerImportRefusal) {
    super('Customer import refused: ' + detail);
  }
}

export interface CustomerImportActor {
  readonly userId: string;
}

export type CustomerImportConflictPolicy = 'reject' | 'update-existing-by-phone';

export interface CreateCustomerImportJobRequest {
  readonly operationId: string;
  readonly conflictPolicy?: CustomerImportConflictPolicy;
  readonly sourceSha256: string;
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sheet: ImportSheet;
  readonly mapping: readonly CustomerColumnMapping[];
}

export interface CustomerImportRowResult {
  readonly sourceRow: number;
  readonly sourceIdentifier: string | null;
  readonly classification: ImportClassification;
  readonly plannedAction: 'create' | 'update' | 'reject';
  readonly status: 'pending' | 'committing' | 'rejected' | 'committed' | 'failed';
  readonly targetEntityId: string | null;
  readonly errorCode: string | null;
  readonly issues: readonly ImportIssue[];
}

export interface CustomerImportRowPage {
  readonly rows: readonly CustomerImportRowResult[];
  readonly nextAfterSourceRow: number | null;
}

export interface CustomerImportSummary {
  readonly id: string;
  readonly domain: 'customers';
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceSha256: string;
  readonly status: 'reviewed' | 'dry-run' | 'committing' | 'completed';
  readonly mappingVersion: number;
  readonly mapping: readonly CustomerColumnMapping[];
  readonly conflictPolicy: CustomerImportConflictPolicy;
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
  readonly created: number;
  readonly updated: number;
  readonly failed: number;
  readonly rejected: number;
  readonly rows: readonly CustomerImportRowResult[];
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

function mappingFromUnknown(value: unknown): CustomerColumnMapping[] {
  if (!Array.isArray(value)) throw new DatabaseError('Customer import mapping is corrupt.');
  const fields = new Set<CustomerImportField>(['nameAr', 'nameEn', 'phone', 'email', 'vatNumber']);
  return value.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DatabaseError('Customer import mapping is corrupt.');
    }
    const candidate = entry as Record<string, unknown>;
    if (!Number.isInteger(candidate.sourceColumn) || (candidate.sourceColumn as number) < 0) {
      throw new DatabaseError('Customer import mapping is corrupt.');
    }
    const target = candidate.targetField;
    if (
      target !== null &&
      (typeof target !== 'string' || !fields.has(target as CustomerImportField))
    ) {
      throw new DatabaseError('Customer import mapping is corrupt.');
    }
    return {
      sourceColumn: candidate.sourceColumn as number,
      targetField: target as CustomerImportField | null,
    };
  });
}

function canonicalFromUnknown(value: unknown): CanonicalCustomerImportRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DatabaseError('Customer import canonical row is missing.');
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.nameAr !== 'string' ||
    (row.nameEn !== null && typeof row.nameEn !== 'string') ||
    (row.phone !== null && typeof row.phone !== 'string') ||
    (row.email !== null && typeof row.email !== 'string') ||
    (row.vatNumber !== null && typeof row.vatNumber !== 'string')
  ) {
    throw new DatabaseError('Customer import canonical row is corrupt.');
  }
  return {
    nameAr: row.nameAr,
    nameEn: row.nameEn as string | null,
    phone: row.phone as string | null,
    email: row.email as string | null,
    vatNumber: row.vatNumber as string | null,
  };
}

function conflictIssue(sourceRow: number): ImportIssue {
  return {
    classification: 'ERROR',
    code: 'phone-conflict',
    message: 'The customer phone already exists in this merchant customer directory.',
    row: sourceRow,
    sourceColumn: null,
    targetField: 'phone',
  };
}

function updatePlannedIssue(sourceRow: number): ImportIssue {
  return {
    classification: 'WARNING',
    code: 'phone-match-update-planned',
    message: 'An existing customer in this merchant matches the phone and will be updated.',
    row: sourceRow,
    sourceColumn: null,
    targetField: 'phone',
  };
}

function conflictPolicyFromUnknown(value: unknown): CustomerImportConflictPolicy {
  if (value === 'reject' || value === 'update-existing-by-phone') return value;
  throw new DatabaseError('Customer import conflict policy is corrupt.');
}

async function lockTenantForCustomerImport(tx: TransactionClient, tenant: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "tenants"
     WHERE "id" = ${tenant}::uuid
     FOR UPDATE`;
  if (rows.length !== 1) {
    throw new DatabaseError('Customer import tenant authority could not be locked.');
  }
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

function customerRowResult(row: {
  sourceRow: number;
  sourceIdentifier: string | null;
  classification: string;
  plannedAction: string;
  status: string;
  targetEntityId: string | null;
  errorCode: string | null;
  issues: unknown;
}): CustomerImportRowResult {
  if (
    row.classification !== 'VALID' &&
    row.classification !== 'WARNING' &&
    row.classification !== 'ERROR' &&
    row.classification !== 'BLOCKED'
  ) {
    throw new DatabaseError('Customer import row carries unknown classification.');
  }
  if (
    row.plannedAction !== 'create' &&
    row.plannedAction !== 'update' &&
    row.plannedAction !== 'reject'
  ) {
    throw new DatabaseError('Customer import row carries unknown action.');
  }
  if (
    row.status !== 'pending' &&
    row.status !== 'committing' &&
    row.status !== 'rejected' &&
    row.status !== 'committed' &&
    row.status !== 'failed'
  ) {
    throw new DatabaseError('Customer import row carries unknown status.');
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
): Promise<CustomerImportSummary | null> {
  const job = await tx.migrationImportJob.findFirst({
    where: { tenantId: tenant, id: jobId },
  });
  if (job === null) return null;
  if (job.domain !== 'customers' || (job.format !== 'csv' && job.format !== 'xlsx')) {
    throw new DatabaseError('Customer import job carries unsupported domain/format.');
  }
  if (
    job.status !== 'reviewed' &&
    job.status !== 'dry-run' &&
    job.status !== 'committing' &&
    job.status !== 'completed'
  ) {
    throw new DatabaseError('Customer import job carries unknown lifecycle status.');
  }

  const [previewRows, statusActionCounts] = await Promise.all([
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
      by: ['status', 'plannedAction'],
      where: { tenantId: tenant, jobId },
      _count: { _all: true },
    }),
  ]);
  const count = (status: string, plannedAction?: string) =>
    statusActionCounts
      .filter(
        (entry) =>
          entry.status === status &&
          (plannedAction === undefined || entry.plannedAction === plannedAction),
      )
      .reduce((total, entry) => total + entry._count._all, 0);
  const rows = previewRows.map(customerRowResult);

  return {
    id: job.id,
    domain: 'customers',
    format: job.format,
    sourceFileName: job.sourceFileName,
    sourceSystem: job.sourceSystem,
    sourceSha256: job.sourceSha256,
    status: job.status,
    mappingVersion: job.mappingVersion,
    mapping: mappingFromUnknown(job.mapping),
    conflictPolicy: conflictPolicyFromUnknown(job.conflictPolicy),
    totalRows: job.totalRows,
    validRows: job.validRows,
    warningRows: job.warningRows,
    errorRows: job.errorRows,
    blockedRows: job.blockedRows,
    created: count('committed', 'create'),
    updated: count('committed', 'update'),
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

export async function readCustomerImportRows(
  prisma: PrismaClient,
  scope: TenantScope,
  jobId: string,
  options: {
    readonly limit: number;
    readonly afterSourceRow: number | null;
    readonly problemsOnly: boolean;
  },
): Promise<CustomerImportRowPage | null> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
    throw new CustomerImportRefusedError('invalid-operation');
  }
  if (
    options.afterSourceRow !== null &&
    (!Number.isInteger(options.afterSourceRow) || options.afterSourceRow < 1)
  ) {
    throw new CustomerImportRefusedError('invalid-operation');
  }

  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'customers' },
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
      rows: pageRows.map(customerRowResult),
      nextAfterSourceRow:
        hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]!.sourceRow : null,
    };
  });
}

export async function createCustomerImportJob(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CustomerImportActor,
  request: CreateCustomerImportJobRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<CustomerImportSummary> {
  if (!validSha256(request.sourceSha256)) {
    throw new CustomerImportRefusedError('invalid-source-hash');
  }
  if (request.sheet.rows[0] === undefined) {
    throw new CustomerImportRefusedError('invalid-operation');
  }

  const conflictPolicy = request.conflictPolicy ?? 'reject';
  const reviews = reviewCustomerSheet(request.sheet, request.mapping);
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
    conflictPolicy,
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
        if (existing.createRequestHash !== requestHash || existing.domain !== 'customers') {
          throw new CustomerImportRefusedError('idempotency-conflict');
        }
        const replay = await summaryWithin(tx, tenant, existing.id);
        if (replay === null) throw new DatabaseError('Customer import replay disappeared.');
        return replay;
      }

      await tx.migrationImportJob.create({
        data: {
          id: jobId,
          tenantId: tenant,
          actorUserId: actor.userId,
          domain: 'customers',
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
          conflictPolicy,
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
              sourceIdentifier: review.record?.phone ?? review.record?.nameAr ?? null,
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
          eventType: 'migration.customer.review-created',
          entityType: 'migration-import-job',
          entityId: jobId,
          metadata: {
            format: request.format,
            sourceSha256: request.sourceSha256,
            conflictPolicy,
            ...counts,
          },
          occurredAt: at,
        },
      });

      const result = await summaryWithin(tx, tenant, jobId);
      if (result === null) throw new DatabaseError('Customer import job could not be read back.');
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
        existing.domain !== 'customers'
      ) {
        throw new CustomerImportRefusedError('idempotency-conflict');
      }
      const replay = await summaryWithin(tx, tenant, existing.id);
      if (replay === null) throw new DatabaseError('Customer import replay could not be read.');
      return replay;
    });
  }
}

export async function readCustomerImportJob(
  prisma: PrismaClient,
  scope: TenantScope,
  jobId: string,
): Promise<CustomerImportSummary | null> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, (tx) => summaryWithin(tx, tenant, jobId));
}

export async function dryRunCustomerImport(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CustomerImportActor,
  jobId: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<CustomerImportSummary> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'customers' },
      select: { id: true, status: true, conflictPolicy: true },
    });
    if (job === null) throw new CustomerImportRefusedError('unknown-job');
    if (job.status !== 'reviewed') {
      const existing = await summaryWithin(tx, tenant, jobId);
      if (existing === null) throw new CustomerImportRefusedError('unknown-job');
      return existing;
    }

    const conflictPolicy = conflictPolicyFromUnknown(job.conflictPolicy);
    const rows = await tx.migrationImportRow.findMany({
      where: { tenantId: tenant, jobId, status: 'pending', plannedAction: 'create' },
      orderBy: { sourceRow: 'asc' },
    });
    for (const row of rows) {
      const canonical = canonicalFromUnknown(row.canonicalData);
      if (canonical.phone !== null) {
        const exists = await tx.customer.findFirst({
          where: { tenantId: tenant, phone: canonical.phone },
          select: { id: true },
        });
        if (exists !== null) {
          const issue =
            conflictPolicy === 'update-existing-by-phone'
              ? updatePlannedIssue(row.sourceRow)
              : conflictIssue(row.sourceRow);
          const issues = [...issuesFromUnknown(row.issues), issue];
          await tx.migrationImportRow.update({
            where: { id: row.id },
            data: {
              issues: jsonObject(issues),
              classification: classifyImportIssues(issues),
              plannedAction:
                conflictPolicy === 'update-existing-by-phone' ? 'update' : 'reject',
              status: conflictPolicy === 'update-existing-by-phone' ? 'pending' : 'rejected',
              errorCode: null,
            },
          });
        }
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
      else throw new DatabaseError('Customer import row classification is corrupt.');
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
        eventType: 'migration.customer.dry-run',
        entityType: 'migration-import-job',
        entityId: jobId,
        metadata: { ...counts, conflictPolicy },
        occurredAt: at,
      },
    });

    const result = await summaryWithin(tx, tenant, jobId);
    if (result === null) throw new CustomerImportRefusedError('unknown-job');
    return result;
  });
}

async function processPendingCustomerRow(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CustomerImportActor,
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
        plannedAction: { in: ['create', 'update'] },
      },
      data: { status: 'committing' },
    });
    if (claimed.count !== 1) return;

    const row = await tx.migrationImportRow.findFirst({
      where: { id: rowId, tenantId: tenant, jobId },
    });
    if (row === null) throw new DatabaseError('Claimed customer import row disappeared.');
    const canonical = canonicalFromUnknown(row.canonicalData);
    const at = clock();

    await tx.$executeRawUnsafe('SAVEPOINT korvi_customer_import_row');
    try {
      const job = await tx.migrationImportJob.findFirst({
        where: { tenantId: tenant, id: jobId, domain: 'customers' },
        select: { conflictPolicy: true },
      });
      if (job === null) throw new CustomerImportRefusedError('unknown-job');
      const conflictPolicy = conflictPolicyFromUnknown(job.conflictPolicy);

      await lockTenantForCustomerImport(tx, tenant);
      const existing =
        canonical.phone === null
          ? null
          : await tx.customer.findFirst({
              where: { tenantId: tenant, phone: canonical.phone },
              select: { id: true },
            });

      const actualAction =
        existing !== null && conflictPolicy === 'update-existing-by-phone' ? 'update' : 'create';
      const customer =
        actualAction === 'update'
          ? await updateMerchantCustomerWithin(
              tx,
              tenant,
              actor,
              existing!.id,
              {
                nameAr: canonical.nameAr,
                nameEn: canonical.nameEn,
                phone: canonical.phone,
                email: canonical.email,
                vatNumber: canonical.vatNumber,
              },
              at,
              nextId,
            )
          : await createMerchantCustomerWithin(
              tx,
              tenant,
              actor,
              {
                nameAr: canonical.nameAr,
                nameEn: canonical.nameEn,
                phone: canonical.phone,
                email: canonical.email,
                vatNumber: canonical.vatNumber,
              },
              at,
              nextId,
            );
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT korvi_customer_import_row');
      await tx.migrationImportRow.update({
        where: { id: row.id },
        data: {
          status: 'committed',
          plannedAction: actualAction,
          targetEntityId: customer.id,
          errorCode: null,
          updatedAt: at,
        },
      });
      await clearSourceData(tx, tenant, jobId, row.id);
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT korvi_customer_import_row');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT korvi_customer_import_row');

      let errorCode: string;
      let issue: ImportIssue;
      if (error instanceof CustomerAdminRefusedError) {
        errorCode = error.detail;
        issue =
          error.detail === 'phone-taken'
            ? conflictIssue(row.sourceRow)
            : commitIssue(
                row.sourceRow,
                'commit-' + error.detail,
                'The row was refused by the authoritative customer writer during commit.',
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

export async function commitCustomerImport(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CustomerImportActor,
  jobId: string,
  operationId: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<CustomerImportSummary> {
  const tenant = tenantParam(scope);

  await withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'customers' },
      select: { status: true, commitOperationId: true },
    });
    if (job === null) throw new CustomerImportRefusedError('unknown-job');
    if (job.commitOperationId !== null && job.commitOperationId !== operationId) {
      throw new CustomerImportRefusedError('idempotency-conflict');
    }
    if (job.status === 'completed') return;
    if (job.status !== 'dry-run' && job.status !== 'committing') {
      throw new CustomerImportRefusedError('job-not-ready');
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
          throw new CustomerImportRefusedError('idempotency-conflict');
        }
      }
    }
  });

  while (true) {
    const ids = await withTenant(prisma, scope.tenantId, (tx) =>
      tx.migrationImportRow.findMany({
        where: {
          tenantId: tenant,
          jobId,
          status: 'pending',
          plannedAction: { in: ['create', 'update'] },
        },
        select: { id: true },
        orderBy: { sourceRow: 'asc' },
        take: ROW_BATCH,
      }),
    );
    if (ids.length === 0) break;
    for (const row of ids) {
      await processPendingCustomerRow(prisma, scope, actor, jobId, row.id, clock, nextId);
    }
  }

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const job = await tx.migrationImportJob.findFirst({
      where: { tenantId: tenant, id: jobId, domain: 'customers' },
      select: { status: true, commitOperationId: true },
    });
    if (job === null) throw new CustomerImportRefusedError('unknown-job');
    if (job.commitOperationId !== operationId) {
      throw new CustomerImportRefusedError('idempotency-conflict');
    }

    if (job.status !== 'completed') {
      const counts = await tx.migrationImportRow.groupBy({
        by: ['status', 'plannedAction'],
        where: { tenantId: tenant, jobId },
        _count: { _all: true },
      });
      const count = (status: string, plannedAction?: string) =>
        counts
          .filter(
            (entry) =>
              entry.status === status &&
              (plannedAction === undefined || entry.plannedAction === plannedAction),
          )
          .reduce((total, entry) => total + entry._count._all, 0);
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
          eventType: 'migration.customer.completed',
          entityType: 'migration-import-job',
          entityId: jobId,
          metadata: {
            created: count('committed', 'create'),
            updated: count('committed', 'update'),
            failed: count('failed'),
            rejected: count('rejected'),
          },
          occurredAt: at,
        },
      });
    }

    const result = await summaryWithin(tx, tenant, jobId);
    if (result === null) throw new CustomerImportRefusedError('unknown-job');
    return result;
  });
}
