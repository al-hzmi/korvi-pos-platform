import { readFileSync, writeFileSync } from 'node:fs';

const path = 'packages/database/prisma/schema.prisma';
let schema = readFileSync(path, 'utf8');

if (schema.includes('model InventoryCostBalance {')) {
  process.exit(0);
}

function replaceOnce(label, before, after) {
  const first = schema.indexOf(before);
  if (first === -1) throw new Error(`5C schema anchor missing: ${label}`);
  if (schema.indexOf(before, first + 1) !== -1) {
    throw new Error(`5C schema anchor is not unique: ${label}`);
  }
  schema = schema.slice(0, first) + after + schema.slice(first + before.length);
}

replaceOnce(
  'tenant inventory relations',
  `  inventoryBalances  InventoryBalance[]\n  inventoryMovements InventoryMovement[]\n`,
  `  inventoryBalances        InventoryBalance[]\n  inventoryMovements       InventoryMovement[]\n  inventoryCostBalances    InventoryCostBalance[]\n  inventoryValuationEvents InventoryValuationEvent[]\n`,
);

replaceOnce(
  'branch inventory relations',
  `  inventoryBalances  InventoryBalance[]\n  inventoryMovements InventoryMovement[]\n  inventoryAdjustments InventoryAdjustment[]\n`,
  `  inventoryBalances        InventoryBalance[]\n  inventoryMovements       InventoryMovement[]\n  inventoryCostBalances    InventoryCostBalance[]\n  inventoryValuationEvents InventoryValuationEvent[]\n  inventoryAdjustments InventoryAdjustment[]\n`,
);

replaceOnce(
  'user costing evidence relation',
  `  purchaseOrders       PurchaseOrder[]\n  purchaseReceipts     PurchaseReceipt[]\n\n  @@unique([tenantId, email])\n`,
  `  purchaseOrders            PurchaseOrder[]\n  purchaseReceipts          PurchaseReceipt[]\n  inventoryValuationEvents InventoryValuationEvent[]\n\n  @@unique([tenantId, email])\n`,
);

replaceOnce(
  'product costing relations',
  `  inventoryBalances  InventoryBalance[]\n  inventoryMovements InventoryMovement[]\n  inventoryAdjustmentLines InventoryAdjustmentLine[]\n`,
  `  inventoryBalances        InventoryBalance[]\n  inventoryMovements       InventoryMovement[]\n  inventoryCostBalances    InventoryCostBalance[]\n  inventoryValuationEvents InventoryValuationEvent[]\n  inventoryAdjustmentLines InventoryAdjustmentLine[]\n`,
);

replaceOnce(
  'movement cost evidence',
  `  actorUserId String?  @db.Uuid\n  occurredAt  DateTime\n  createdAt   DateTime @default(now())\n\n  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n`,
  `  /// Exact immutable valuation evidence for this stock movement. The two\n  /// quantities are absolute magnitudes and always reconcile to abs(quantityScaled).\n  costKnownQuantityScaled   BigInt @default(0)\n  costUnknownQuantityScaled BigInt @default(0)\n  costValueMinor            BigInt @default(0)\n  /// 'historical-unknown' | 'unknown' | 'recorded' | 'mixed'\n  costProvenance            String @default("historical-unknown")\n\n  actorUserId String?  @db.Uuid\n  occurredAt  DateTime\n  createdAt   DateTime @default(now())\n\n  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n`,
);

replaceOnce(
  'insert costing models',
  `  @@map("inventory_movements")\n}\n\n// ---------------------------------------------------------------------------\n// Stock documents (Strike 5A)\n`,
  `  @@map("inventory_movements")\n}\n\n/// Exact known-value subset of the branch/product stock balance. This table\n/// deliberately does not duplicate total stock quantity; unknown positive stock\n/// is derived from inventory_balances.quantityScaled - knownQuantityScaled.\nmodel InventoryCostBalance {\n  tenantId  String @db.Uuid\n  branchId  String @db.Uuid\n  productId String @db.Uuid\n\n  knownQuantityScaled BigInt @default(0)\n  knownValueMinor      BigInt @default(0)\n  stockRevision        BigInt @default(0)\n  costRevision         BigInt @default(0)\n  updatedAt            DateTime @updatedAt\n\n  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n  branch  Branch  @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: NoAction)\n  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: NoAction)\n\n  @@id([tenantId, branchId, productId])\n  @@index([tenantId, branchId])\n  @@map("inventory_cost_balances")\n}\n\n/// Append-only valuation evidence. Stock movements, explicit valuation\n/// bootstrap and negative-stock catch-up all leave facts here; none rewrites\n/// historical documents or fabricates pre-5C cost.\nmodel InventoryValuationEvent {\n  id        String @id @db.Uuid\n  tenantId  String @db.Uuid\n  branchId  String @db.Uuid\n  productId String @db.Uuid\n\n  /// 'movement' | 'bootstrap' | 'deficit-catchup'\n  eventKind  String\n  /// 'unknown' | 'recorded' | 'mixed'\n  provenance String\n  knownQuantityScaled   BigInt @default(0)\n  unknownQuantityScaled BigInt @default(0)\n  knownValueMinor       BigInt @default(0)\n\n  sourceType   String?\n  sourceId     String? @db.Uuid\n  sourceLineId String? @db.Uuid\n  actorUserId  String? @db.Uuid\n\n  stockRevision BigInt\n  costRevision  BigInt\n  occurredAt    DateTime\n  createdAt     DateTime @default(now())\n\n  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n  branch  Branch  @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: NoAction)\n  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: NoAction)\n  actor   User?   @relation(fields: [tenantId, actorUserId], references: [tenantId, id], onDelete: NoAction)\n\n  @@unique([tenantId, id])\n  @@index([tenantId, branchId, productId, occurredAt])\n  @@index([tenantId, sourceType, sourceId])\n  @@map("inventory_valuation_events")\n}\n\n// ---------------------------------------------------------------------------\n// Stock documents (Strike 5A)\n`,
);

replaceOnce(
  'receipt line costing fields',
  `  beforeQuantityScaled BigInt\n  afterQuantityScaled BigInt\n  resultRevision       BigInt\n\n  tenant        Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n`,
  `  beforeQuantityScaled BigInt\n  afterQuantityScaled BigInt\n  resultRevision       BigInt\n\n  /// Null means the goods were accepted before trusted acquisition value was\n  /// available. Cost evidence remains explicit unknown rather than blocking stock.\n  inventoryValueMinor       BigInt?\n  costKnownQuantityScaled   BigInt @default(0)\n  costUnknownQuantityScaled BigInt @default(0)\n  costValueMinor            BigInt @default(0)\n  costProvenance            String @default("historical-unknown")\n\n  tenant        Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n`,
);

replaceOnce(
  'sale line costing fields',
  `  netMinor            BigInt\n  vatMinor            BigInt\n  totalMinor          BigInt\n\n  tenant      Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n`,
  `  netMinor            BigInt\n  vatMinor            BigInt\n  totalMinor          BigInt\n\n  /// Immutable original inventory cost basis. Returns restore this exact basis\n  /// rather than consulting the branch's current moving value pool.\n  costKnownQuantityScaled   BigInt @default(0)\n  costUnknownQuantityScaled BigInt @default(0)\n  costValueMinor            BigInt @default(0)\n  costProvenance            String @default("historical-unknown")\n\n  tenant      Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n`,
);

replaceOnce(
  'return line costing fields',
  `  netMinor            BigInt\n  vatMinor            BigInt\n  totalMinor          BigInt\n\n  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n`,
  `  netMinor            BigInt\n  vatMinor            BigInt\n  totalMinor          BigInt\n\n  /// Exact portion of the original sale-line basis restored by this return.\n  costKnownQuantityScaled   BigInt @default(0)\n  costUnknownQuantityScaled BigInt @default(0)\n  costValueMinor            BigInt @default(0)\n  costProvenance            String @default("historical-unknown")\n\n  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)\n`,
);

writeFileSync(path, schema);
