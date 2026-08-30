import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, label, before, after) {
  const source = readFileSync(path, 'utf8');
  if (source.includes(after)) return;
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`5C bootstrap anchor missing: ${label}`);
  if (source.indexOf(before, first + 1) !== -1) {
    throw new Error(`5C bootstrap anchor is not unique: ${label}`);
  }
  writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length));
}

function appendOnce(path, marker, addition) {
  const source = readFileSync(path, 'utf8');
  if (source.includes(addition.trim())) return;
  const at = source.lastIndexOf(marker);
  if (at === -1) throw new Error(`5C bootstrap tail anchor missing in ${path}`);
  writeFileSync(path, source.slice(0, at) + addition + source.slice(at));
}

replaceOnce(
  'packages/domain/src/costing/costing.ts',
  'uuid import',
  `import { DomainError } from '../errors.js';`,
  `import { DomainError } from '../errors.js';\nimport { canonicalUuid } from '../inventory/stock.js';`,
);

replaceOnce(
  'packages/domain/src/costing/costing.ts',
  'refusal vocabulary',
  `export type CostingRequestRefusal =\n  'invalid-money' | 'invalid-quantity' | 'non-positive-quantity' | 'nothing-to-value';`,
  `export type CostingRequestRefusal =\n  | 'invalid-money'\n  | 'invalid-quantity'\n  | 'non-positive-quantity'\n  | 'invalid-operation-id'\n  | 'nothing-to-value';`,
);

appendOnce(
  'packages/domain/src/costing/costing.ts',
  '\n',
  `\nexport const COST_IDEMPOTENCY_SCOPES = { bootstrap: 'inventory-cost-bootstrap' } as const;\n\nexport interface CostBootstrapRequest {\n  readonly operationId: string;\n  readonly branchId: string;\n  readonly productId: string;\n  readonly totalValueMinor: string;\n}\n\nexport interface ValidatedCostBootstrap {\n  readonly operationId: string;\n  readonly branchId: string;\n  readonly productId: string;\n  readonly totalValueMinor: bigint;\n}\n\nexport function validateCostBootstrapRequest(\n  request: CostBootstrapRequest,\n): ValidatedCostBootstrap {\n  const operationId = request.operationId.trim();\n  if (operationId.length === 0 || operationId.length > 120) {\n    throw new CostingRequestError(\n      'invalid-operation-id',\n      'operationId must contain between 1 and 120 characters.',\n    );\n  }\n  return {\n    operationId,\n    branchId: canonicalUuid(request.branchId, 'branchId'),\n    productId: canonicalUuid(request.productId, 'productId'),\n    totalValueMinor: parseNonNegativeMinor(request.totalValueMinor, 'totalValueMinor'),\n  };\n}\n\n/** Stable intent form: all UUIDs and integer text are canonical before hashing. */\nexport function canonicalCostBootstrapForm(request: CostBootstrapRequest): readonly unknown[] {\n  const plan = validateCostBootstrapRequest(request);\n  return [\n    COST_IDEMPOTENCY_SCOPES.bootstrap,\n    plan.operationId,\n    plan.branchId,\n    plan.productId,\n    plan.totalValueMinor.toString(),\n  ];\n}\n`,
);

appendOnce(
  'packages/domain/src/costing/__tests__/costing.test.ts',
  '\n});\n',
  `\n  it('canonicalizes cost bootstrap intent and refuses malformed money', () => {\n    expect(\n      canonicalCostBootstrapForm({\n        operationId: '  op-1  ',\n        branchId: '018F6000-0000-7000-8000-000000000001',\n        productId: '018F6000-0000-7000-8000-000000000002',\n        totalValueMinor: '100',\n      }),\n    ).toEqual([\n      'inventory-cost-bootstrap',\n      'op-1',\n      '018f6000-0000-7000-8000-000000000001',\n      '018f6000-0000-7000-8000-000000000002',\n      '100',\n    ]);\n\n    expect(() =>\n      canonicalCostBootstrapForm({\n        operationId: 'op-2',\n        branchId: '018f6000-0000-7000-8000-000000000001',\n        productId: '018f6000-0000-7000-8000-000000000002',\n        totalValueMinor: '01',\n      }),\n    ).toThrow(CostingRequestError);\n  });\n`,
);

replaceOnce(
  'packages/domain/src/costing/__tests__/costing.test.ts',
  'bootstrap test imports',
  `  bootstrapUnknownCost,`,
  `  bootstrapUnknownCost,\n  canonicalCostBootstrapForm,\n  CostingRequestError,`,
);

replaceOnce(
  'apps/api/src/inventory/fingerprint.ts',
  'bootstrap canonical import',
  `import { canonicalAdjustmentForm, canonicalCountForm, canonicalTransferForm } from '@korvi/domain';`,
  `import {\n  canonicalAdjustmentForm,\n  canonicalCostBootstrapForm,\n  canonicalCountForm,\n  canonicalTransferForm,\n} from '@korvi/domain';`,
);
replaceOnce(
  'apps/api/src/inventory/fingerprint.ts',
  'bootstrap request type',
  `import type { AdjustmentRequest, CountRequest, TransferRequest } from '@korvi/domain';`,
  `import type {\n  AdjustmentRequest,\n  CostBootstrapRequest,\n  CountRequest,\n  TransferRequest,\n} from '@korvi/domain';`,
);
appendOnce(
  'apps/api/src/inventory/fingerprint.ts',
  '\n',
  `\nexport function fingerprintCostBootstrap(\n  request: CostBootstrapRequest,\n  actorUserId: string,\n): string {\n  return digest(canonicalCostBootstrapForm(request), actorUserId);\n}\n`,
);

const bootstrapPath = 'packages/database/src/costing/bootstrap.ts';
if (!existsSync(bootstrapPath)) {
  writeFileSync(
    bootstrapPath,
    `import {\n  COST_IDEMPOTENCY_SCOPES,\n  bootstrapUnknownCost,\n  newId,\n  validateCostBootstrapRequest,\n} from '@korvi/domain';\nimport { withTenant } from '../tenant-context.js';\nimport {\n  claimOperation,\n  lockBalances,\n  lockBranches,\n  lockedOrThrow,\n  lockProducts,\n} from '../inventory/stock-ledger.js';\nimport { lockCostBalanceWithin } from './ledger.js';\nimport {\n  readOperationSnapshot,\n  snapshotObject,\n  snapshotString,\n  writeOperationSnapshot,\n} from '../purchasing/snapshot.js';\nimport type { CostBootstrapRequest } from '@korvi/domain';\nimport type { PrismaClient } from '../client.js';\n\nexport interface CostBootstrapActor {\n  readonly tenantId: string;\n  readonly userId: string;\n}\n\nexport interface InventoryCostBootstrapResult {\n  readonly id: string;\n  readonly branchId: string;\n  readonly productId: string;\n  readonly valuedQuantityScaled: string;\n  readonly stockRevision: string;\n  readonly costRevision: string;\n  readonly occurredAt: string;\n  readonly replayed: boolean;\n}\n\nfunction fromSnapshot(value: unknown): InventoryCostBootstrapResult {\n  const root = snapshotObject(value, 'inventory-cost-bootstrap-result');\n  return {\n    id: snapshotString(root, 'id'),\n    branchId: snapshotString(root, 'branchId'),\n    productId: snapshotString(root, 'productId'),\n    valuedQuantityScaled: snapshotString(root, 'valuedQuantityScaled'),\n    stockRevision: snapshotString(root, 'stockRevision'),\n    costRevision: snapshotString(root, 'costRevision'),\n    occurredAt: snapshotString(root, 'occurredAt'),\n    replayed: true,\n  };\n}\n\nexport async function recordInventoryCostBootstrap(\n  prisma: PrismaClient,\n  actor: CostBootstrapActor,\n  request: CostBootstrapRequest,\n  requestHash: string,\n  clock: () => Date = () => new Date(),\n): Promise<InventoryCostBootstrapResult> {\n  const plan = validateCostBootstrapRequest(request);\n  const tenant = actor.tenantId;\n\n  return withTenant(prisma, tenant, async (tx) => {\n    const at = clock();\n    const evidenceId = newId();\n    const claim = await claimOperation(\n      tx,\n      tenant,\n      COST_IDEMPOTENCY_SCOPES.bootstrap,\n      plan.operationId,\n      requestHash,\n      'inventory-valuation-event',\n      evidenceId,\n      at,\n    );\n    if (claim.kind === 'replay') {\n      return fromSnapshot(\n        await readOperationSnapshot(\n          tx,\n          tenant,\n          COST_IDEMPOTENCY_SCOPES.bootstrap,\n          plan.operationId,\n        ),\n      );\n    }\n\n    // Canonical authority order: idempotency -> branch -> product -> stock\n    // balance -> cost balance. The quantity to value is derived only after both\n    // mutable authorities are held.\n    await lockBranches(tx, tenant, [plan.branchId]);\n    await lockProducts(tx, tenant, [plan.productId]);\n    const balances = await lockBalances(tx, tenant, [\n      { branchId: plan.branchId, productId: plan.productId },\n    ]);\n    const stock = lockedOrThrow(balances, {\n      branchId: plan.branchId,\n      productId: plan.productId,\n    });\n    const cost = await lockCostBalanceWithin(\n      tx,\n      tenant,\n      plan.branchId,\n      plan.productId,\n      stock.revision,\n    );\n    const valued = bootstrapUnknownCost(\n      stock.quantityScaled,\n      cost,\n      plan.totalValueMinor,\n    );\n    const nextCostRevision = cost.costRevision + 1n;\n\n    const updated = await tx.$executeRaw\`\n      UPDATE "inventory_cost_balances"\n         SET "knownQuantityScaled" = \${valued.knownQuantityScaled},\n             "knownValueMinor" = \${valued.knownValueMinor},\n             "costRevision" = \${nextCostRevision},\n             "updatedAt" = now()\n       WHERE "tenantId" = \${tenant}::uuid\n         AND "branchId" = \${plan.branchId}::uuid\n         AND "productId" = \${plan.productId}::uuid\n         AND "stockRevision" = \${stock.revision}\n         AND "costRevision" = \${cost.costRevision}\`;\n    if (updated !== 1) {\n      throw new Error('Cost bootstrap invariant failed: expected one locked cost balance update.');\n    }\n\n    await tx.inventoryValuationEvent.create({\n      data: {\n        id: evidenceId,\n        tenantId: tenant,\n        branchId: plan.branchId,\n        productId: plan.productId,\n        eventKind: 'bootstrap',\n        provenance: 'recorded',\n        knownQuantityScaled: valued.valuedQuantityScaled,\n        unknownQuantityScaled: 0n,\n        knownValueMinor: valued.addedValueMinor,\n        sourceType: 'cost-bootstrap',\n        sourceId: evidenceId,\n        sourceLineId: null,\n        actorUserId: actor.userId,\n        stockRevision: stock.revision,\n        costRevision: nextCostRevision,\n        occurredAt: at,\n      },\n    });\n\n    await tx.auditEvent.create({\n      data: {\n        id: newId(),\n        tenantId: tenant,\n        actorUserId: actor.userId,\n        branchId: plan.branchId,\n        terminalId: null,\n        eventType: 'inventory.cost.bootstrapped',\n        entityType: 'inventory-valuation-event',\n        entityId: evidenceId,\n        metadata: {\n          operationId: plan.operationId,\n          productId: plan.productId,\n          valuedQuantityScaled: valued.valuedQuantityScaled.toString(),\n        },\n        occurredAt: at,\n      },\n    });\n\n    const result: InventoryCostBootstrapResult = {\n      id: evidenceId,\n      branchId: plan.branchId,\n      productId: plan.productId,\n      valuedQuantityScaled: valued.valuedQuantityScaled.toString(),\n      stockRevision: stock.revision.toString(),\n      costRevision: nextCostRevision.toString(),\n      occurredAt: at.toISOString(),\n      replayed: false,\n    };\n    await writeOperationSnapshot(\n      tx,\n      tenant,\n      COST_IDEMPOTENCY_SCOPES.bootstrap,\n      plan.operationId,\n      result,\n    );\n    return result;\n  });\n}\n`,
  );
}

replaceOnce(
  'packages/database/src/index.ts',
  'bootstrap database export',
  `export type { BalancePage, BalancePageRow } from './inventory/balances.js';`,
  `export type { BalancePage, BalancePageRow } from './inventory/balances.js';\n\n// Prospective costing bootstrap (Strike 5C). It values only the currently\n// unknown positive quantity derived under stock + cost row locks; it never\n// changes stock quantity/revision or rewrites historical movement evidence.\nexport { recordInventoryCostBootstrap } from './costing/bootstrap.js';\nexport type {\n  CostBootstrapActor,\n  InventoryCostBootstrapResult,\n} from './costing/bootstrap.js';`,
);

replaceOnce(
  'apps/api/src/inventory/service.ts',
  'service domain imports',
  `import { StockRequestError } from '@korvi/domain';`,
  `import { CostingRequestError, StockRequestError, requirePrincipalPermission } from '@korvi/domain';`,
);
replaceOnce(
  'apps/api/src/inventory/service.ts',
  'service database import',
  `  recordInventoryAdjustment,`,
  `  recordInventoryAdjustment,\n  recordInventoryCostBootstrap,`,
);
replaceOnce(
  'apps/api/src/inventory/service.ts',
  'service fingerprint import',
  `import { fingerprintAdjustment, fingerprintCount, fingerprintTransfer } from './fingerprint.js';`,
  `import {\n  fingerprintAdjustment,\n  fingerprintCostBootstrap,\n  fingerprintCount,\n  fingerprintTransfer,\n} from './fingerprint.js';`,
);
replaceOnce(
  'apps/api/src/inventory/service.ts',
  'service request type',
  `  CountRequest,\n  StockRequestRefusal,`,
  `  CostBootstrapRequest,\n  CostingRequestRefusal,\n  CountRequest,\n  StockRequestRefusal,`,
);
replaceOnce(
  'apps/api/src/inventory/service.ts',
  'service result type',
  `  CountResult,\n  PrismaClient,`,
  `  CountResult,\n  InventoryCostBootstrapResult,\n  PrismaClient,`,
);
replaceOnce(
  'apps/api/src/inventory/service.ts',
  'failure union',
  `export type StockFailureReason = StockRequestRefusal | StockOperationRefusal;`,
  `export type StockFailureReason =\n  | StockRequestRefusal\n  | CostingRequestRefusal\n  | StockOperationRefusal;`,
);
replaceOnce(
  'apps/api/src/inventory/service.ts',
  'service interface bootstrap',
  `  adjust(\n    principal: AuthenticatedPrincipal,`,
  `  bootstrapCost(\n    principal: AuthenticatedPrincipal,\n    request: CostBootstrapRequest,\n  ): Promise<StockResult<InventoryCostBootstrapResult>>;\n  adjust(\n    principal: AuthenticatedPrincipal,`,
);
replaceOnce(
  'apps/api/src/inventory/service.ts',
  'attempt costing error',
  `    if (error instanceof StockRequestError) {\n      return { outcome: 'failure', reason: error.detail, productId: null };\n    }`,
  `    if (error instanceof StockRequestError || error instanceof CostingRequestError) {\n      return { outcome: 'failure', reason: error.detail, productId: null };\n    }`,
);
replaceOnce(
  'apps/api/src/inventory/service.ts',
  'service implementation bootstrap',
  `    async adjust(principal, request) {`,
  `    async bootstrapCost(principal, request) {\n      // Defense in depth: internal callers cannot bypass the route's permission.\n      requirePrincipalPermission(principal, 'inventory.cost.manage');\n      return attempt(() =>\n        recordInventoryCostBootstrap(\n          prisma,\n          { tenantId: principal.tenantId, userId: principal.userId },\n          request,\n          fingerprintCostBootstrap(request, principal.userId),\n        ),\n      );\n    },\n\n    async adjust(principal, request) {`,
);

replaceOnce(
  'apps/api/src/routes/inventory-admin.ts',
  'bootstrap body schema',
  `const balancesQuery = z`,
  `const costBootstrapBody = z\n  .object({\n    operationId: OPERATION_ID,\n    branchId: UUID,\n    productId: UUID,\n    totalValueMinor: z.string().regex(/^(0|[1-9][0-9]{0,18})$/),\n  })\n  .strict();\n\nconst balancesQuery = z`,
);
replaceOnce(
  'apps/api/src/routes/inventory-admin.ts',
  'cost failure messages',
  `  'invalid-uuid': 'معرّف غير صالح.',`,
  `  'invalid-uuid': 'معرّف غير صالح.',\n  'invalid-money': 'قيمة التكلفة غير صالحة.',\n  'invalid-operation-id': 'رقم العملية غير صالح.',\n  'nothing-to-value': 'لا توجد كمية موجبة مجهولة التكلفة لتقييمها.',`,
);
replaceOnce(
  'apps/api/src/routes/inventory-admin.ts',
  'cost failure statuses',
  `  'invalid-uuid': 422,`,
  `  'invalid-uuid': 422,\n  'invalid-money': 422,\n  'invalid-operation-id': 422,\n  'nothing-to-value': 409,`,
);
replaceOnce(
  'apps/api/src/routes/inventory-admin.ts',
  'bootstrap route',
  `  app.post(\n    '/v1/admin/inventory/adjustments',`,
  `  app.post(\n    '/v1/admin/inventory/cost-bootstrap',\n    { preHandler: [guards.requireSession, guards.requirePermission('inventory.cost.manage')] },\n    async (request, reply) => {\n      const principal = principalOf(request);\n      if (principal === undefined) return reply.code(401).send({ error: 'unauthenticated' });\n\n      const field = forbiddenField(request.body, FORBIDDEN_STOCK_FIELDS);\n      if (field !== null) return reply.code(400).send({ error: 'forbidden_field', field });\n      const parsed = costBootstrapBody.safeParse(request.body);\n      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });\n\n      const result = await service.bootstrapCost(principal, parsed.data);\n      if (result.outcome === 'failure') {\n        return failure(reply, result.reason, result.productId);\n      }\n      return reply.code(result.value.replayed ? 200 : 201).send(result.value);\n    },\n  );\n\n  app.post(\n    '/v1/admin/inventory/adjustments',`,
);
