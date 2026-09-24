import { withTenant } from '../tenant-context.js';
import { DatabaseError, OperationAlreadyRecordedError } from '../errors.js';
import { applyMovementWithin, lockInventoryBalancesWithin } from './inventory-repository.js';
import { recordSaleWithin } from './sale-repository.js';
import { iso, minor, oneOf, rate, scoped, tenantParam } from './mapping.js';
import type {
  NoReceiptExchangeLineRecord,
  NoReceiptExchangeRecord,
  NoReceiptExchangeRepository,
  ProductType,
  RecordNoReceiptExchangeInput,
  TenantScope,
} from '@korvi/domain';
import type { TransactionClient } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

const PRODUCT_TYPES: readonly ProductType[] = ['unit', 'weighted'];

interface LineRow {
  id: string;
  lineNumber: number;
  productId: string;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  productType: string;
  quantityScaled: bigint;
  currentUnitReferencePriceMinor: bigint;
  currentVatBasisPoints: number;
  currentReferenceTotalMinor: bigint;
  trackInventory: boolean;
  stockDisposition: string;
  costProvenance: string;
}

interface CaseRow {
  id: string;
  tenantId: string;
  branchId: string;
  terminalId: string;
  shiftId: string;
  actorUserId: string;
  operationId: string;
  requestHash: string;
  status: string;
  sequence: number;
  caseNumber: string;
  reason: string;
  evidenceNote: string;
  currency: string;
  referenceCeilingMinor: bigint;
  approvedAllowanceMinor: bigint;
  linkedSaleId: string;
  issuedAt: Date;
  lines: LineRow[];
}

function lineToDomain(row: LineRow): NoReceiptExchangeLineRecord {
  if (row.stockDisposition !== 'sellable' || row.costProvenance !== 'unknown') {
    throw new DatabaseError('No-receipt exchange line holds an unsupported policy snapshot.');
  }
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productId: row.productId,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    productType: oneOf(PRODUCT_TYPES, row.productType, 'no_receipt_exchange_lines.productType'),
    quantityScaled: minor(row.quantityScaled),
    currentUnitReferencePriceMinor: minor(row.currentUnitReferencePriceMinor),
    currentVatBasisPoints: rate(row.currentVatBasisPoints),
    currentReferenceTotalMinor: minor(row.currentReferenceTotalMinor),
    trackInventory: row.trackInventory,
    stockDisposition: 'sellable',
    costProvenance: 'unknown',
  };
}

function caseToDomain(scope: TenantScope, row: CaseRow): NoReceiptExchangeRecord {
  if (row.status !== 'finalized') {
    throw new DatabaseError('No-receipt exchange case is not a finalized immutable fact.');
  }
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    terminalId: row.terminalId,
    shiftId: row.shiftId,
    actorUserId: row.actorUserId,
    operationId: row.operationId,
    requestHash: row.requestHash,
    status: 'finalized',
    sequence: row.sequence,
    caseNumber: row.caseNumber,
    reason: row.reason,
    evidenceNote: row.evidenceNote,
    currency: row.currency,
    referenceCeilingMinor: minor(row.referenceCeilingMinor),
    approvedAllowanceMinor: minor(row.approvedAllowanceMinor),
    linkedSaleId: row.linkedSaleId,
    issuedAt: iso(row.issuedAt),
    lines: row.lines.map(lineToDomain),
  };
}

const WITH_LINES = { lines: { orderBy: { lineNumber: 'asc' as const } } } as const;

async function loadCase(
  tx: TransactionClient,
  tenant: string,
  where: { id: string } | { operationId: string },
): Promise<CaseRow | null> {
  return tx.noReceiptExchangeCase.findFirst({
    where: { tenantId: tenant, ...where },
    include: WITH_LINES,
  });
}

async function reserveCompositeOperation(
  tx: TransactionClient,
  tenant: string,
  input: RecordNoReceiptExchangeInput,
): Promise<void> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "idempotency_keys"
      ("id","tenantId","scope","operationId","status","resultType","resultId","requestHash","completedAt")
    VALUES (
      ${input.replacementSale.idempotency.id}::uuid,
      ${tenant}::uuid,
      'no-receipt-exchange',
      ${input.exchange.operationId},
      'completed',
      'no-receipt-exchange',
      ${input.exchange.id}::uuid,
      ${input.exchange.requestHash},
      ${new Date(input.exchange.issuedAt)}
    )
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
    RETURNING "id"`;
  if (inserted.length === 0) {
    throw new OperationAlreadyRecordedError(input.exchange.operationId);
  }
}

async function allocateCaseNumber(
  tx: TransactionClient,
  tenant: string,
  branchId: string,
): Promise<{ sequence: number; caseNumber: string }> {
  const branches = await tx.$queryRaw<{ code: string }[]>`
    SELECT "code" FROM "branches"
     WHERE "tenantId" = ${tenant}::uuid AND "id" = ${branchId}::uuid
     FOR UPDATE`;
  const branch = branches.at(0);
  if (branch === undefined) {
    throw new DatabaseError('No such branch in this tenant; refusing no-receipt exchange.');
  }
  const next = await tx.$queryRaw<{ sequence: number }[]>`
    SELECT COALESCE(MAX("sequence"), 0) + 1 AS "sequence"
      FROM "no_receipt_exchange_cases"
     WHERE "tenantId" = ${tenant}::uuid AND "branchId" = ${branchId}::uuid`;
  const sequence = Number(next.at(0)?.sequence ?? 1);
  return {
    sequence,
    caseNumber: `NR-${branch.code}-${String(sequence).padStart(6, '0')}`,
  };
}

function assertCompositeShape(input: RecordNoReceiptExchangeInput): void {
  const { exchange, replacementSale, lines, intake, audit } = input;
  const sale = replacementSale.sale;
  if (
    sale.branchId !== exchange.branchId ||
    sale.terminalId !== exchange.terminalId ||
    sale.shiftId !== exchange.shiftId ||
    sale.userId !== exchange.actorUserId
  ) {
    throw new DatabaseError('Replacement sale authority must match the no-receipt exchange actor/till.');
  }
  if (audit.entityId !== exchange.id || audit.actorUserId !== exchange.actorUserId) {
    throw new DatabaseError('No-receipt exchange audit identity does not match the case.');
  }

  const byLineId = new Map(lines.map((line) => [line.id, line] as const));
  const expectedTracked = new Set(lines.filter((line) => line.trackInventory).map((line) => line.id));
  const actualTracked = new Set<string>();

  for (const entry of intake) {
    const line = byLineId.get(entry.caseLineId);
    if (line === undefined || !line.trackInventory || actualTracked.has(entry.caseLineId)) {
      throw new DatabaseError('No-receipt intake does not map one-to-one to tracked accepted lines.');
    }
    actualTracked.add(entry.caseLineId);
    const movement = entry.movement;
    if (
      movement.kind !== 'no-receipt-exchange-intake' ||
      movement.branchId !== exchange.branchId ||
      movement.productId !== line.productId ||
      movement.quantityScaled !== line.quantityScaled ||
      BigInt(movement.quantityScaled) <= 0n ||
      movement.sourceType !== 'no-receipt-exchange' ||
      movement.sourceId !== exchange.id ||
      movement.actorUserId !== exchange.actorUserId
    ) {
      throw new DatabaseError('No-receipt intake movement does not match its accepted-line snapshot.');
    }
  }
  if (
    actualTracked.size !== expectedTracked.size ||
    [...expectedTracked].some((lineId) => !actualTracked.has(lineId))
  ) {
    throw new DatabaseError('Every tracked accepted line must have exactly one intake movement.');
  }
}

export function createNoReceiptExchangeRepository(
  prisma: PrismaClient,
): NoReceiptExchangeRepository {
  return {
    async findByOperationId(
      scope: TenantScope,
      operationId: string,
    ): Promise<NoReceiptExchangeRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadCase(tx, tenantParam(scope), { operationId });
        return row === null ? null : caseToDomain(scope, row);
      });
    },

    async record(
      scope: TenantScope,
      input: RecordNoReceiptExchangeInput,
    ): Promise<NoReceiptExchangeRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        assertCompositeShape(input);

        // This reservation is the single replay authority for the whole
        // exchange. The nested sale deliberately does not mint a second key.
        await reserveCompositeOperation(tx, tenant, input);

        // Branch lock is the document-number serialization boundary shared by
        // sale receipt allocation and this case series.
        const number = await allocateCaseNumber(tx, tenant, input.exchange.branchId);

        // Pre-lock every stock row the two-sided operation may touch in one
        // deterministic order. Intake and replacement sale then reuse the same
        // canonical stock/cost ledger under these locks.
        await lockInventoryBalancesWithin(
          tx,
          tenant,
          input.exchange.branchId,
          [
            ...input.intake.map((entry) => entry.movement.productId),
            ...input.replacementSale.inventory.map((movement) => movement.productId),
          ],
        );

        for (const entry of input.intake) {
          // No incoming cost basis is passed: absent historical evidence is
          // represented by the costing ledger as explicit unknown, never zero.
          await applyMovementWithin(
            tx,
            tenant,
            entry.movement,
            true,
            entry.caseLineId,
          );
        }

        const replacement = await recordSaleWithin(
          tx,
          scope,
          input.replacementSale,
          { skipIdempotencyReservation: true },
        );

        await tx.noReceiptExchangeCase.create({
          data: {
            id: input.exchange.id,
            tenantId: tenant,
            branchId: input.exchange.branchId,
            terminalId: input.exchange.terminalId,
            shiftId: input.exchange.shiftId,
            actorUserId: input.exchange.actorUserId,
            operationId: input.exchange.operationId,
            requestHash: input.exchange.requestHash,
            status: 'finalized',
            sequence: number.sequence,
            caseNumber: number.caseNumber,
            reason: input.exchange.reason,
            evidenceNote: input.exchange.evidenceNote,
            currency: input.exchange.currency,
            referenceCeilingMinor: BigInt(input.exchange.referenceCeilingMinor),
            approvedAllowanceMinor: BigInt(input.exchange.approvedAllowanceMinor),
            linkedSaleId: replacement.id,
            issuedAt: new Date(input.exchange.issuedAt),
          },
        });

        await tx.noReceiptExchangeLine.createMany({
          data: input.lines.map((line) => ({
            id: line.id,
            tenantId: tenant,
            caseId: input.exchange.id,
            productId: line.productId,
            lineNumber: line.lineNumber,
            sku: line.sku,
            nameAr: line.nameAr,
            nameEn: line.nameEn,
            productType: line.productType,
            quantityScaled: BigInt(line.quantityScaled),
            currentUnitReferencePriceMinor: BigInt(line.currentUnitReferencePriceMinor),
            currentVatBasisPoints: Number(line.currentVatBasisPoints),
            currentReferenceTotalMinor: BigInt(line.currentReferenceTotalMinor),
            trackInventory: line.trackInventory,
            stockDisposition: 'sellable',
            costProvenance: 'unknown',
          })),
        });

        await tx.auditEvent.create({
          data: {
            id: input.audit.id,
            tenantId: tenant,
            actorUserId: input.audit.actorUserId,
            branchId: input.audit.branchId,
            terminalId: input.audit.terminalId,
            eventType: input.audit.eventType,
            entityType: input.audit.entityType,
            entityId: input.audit.entityId,
            ...(input.audit.metadata === null ? {} : { metadata: { ...input.audit.metadata } }),
            occurredAt: new Date(input.audit.occurredAt),
          },
        });

        const row = await loadCase(tx, tenant, { id: input.exchange.id });
        if (row === null) {
          throw new DatabaseError('The no-receipt exchange just written could not be read back.');
        }
        return caseToDomain(scope, row);
      });
    },
  };
}
