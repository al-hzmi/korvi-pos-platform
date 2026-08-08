#!/usr/bin/env bash
#
# setup-korvi-strike2a-saas-database.sh — Korvi POS · Strike 2A
#
# The SaaS database and tenant-isolation foundation, on top of Strike 1
# Domain Core (main @ a403aee):
#
#   prisma/schema.prisma      31 models: tenancy, catalogue, inventory,
#                             sales, invoices, returns, idempotency, audit
#   prisma/migrations/...     forward-only migration with RLS on every
#                             tenant-owned table, and tenant-consistent
#                             composite foreign keys between all of them
#   packages/domain/ports/    persistence DTOs — no Prisma type crosses here
#   packages/database/src/    tenant-scoped repositories
#
# No auth, no API, no UI, no ZATCA, no printing.
#
# Run from the repository root. Never commits, pushes, resets, or cleans.

set -euo pipefail

if [ -t 1 ]; then
  C_B='\033[1;34m'; C_Y='\033[1;33m'; C_R='\033[1;31m'; C_G='\033[1;32m'; C_0='\033[0m'
else
  C_B=''; C_Y=''; C_R=''; C_G=''; C_0=''
fi
say()  { printf "${C_B}==>${C_0} %s\n" "$1"; }
ok()   { printf "${C_G}[ok]${C_0} %s\n" "$1"; }
warn() { printf "${C_Y}[!]${C_0} %s\n" "$1" >&2; }
die()  { printf "${C_R}[x]${C_0} %s\n" "$1" >&2; exit 1; }

RUN_VERIFY=1
ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --no-verify)   RUN_VERIFY=0 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    -h|--help) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $arg" ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "Not inside a git repository."
cd "$ROOT"

[ "$(node -p "require('./package.json').name" 2>/dev/null)" = "korvi-pos-platform" ] \
  || die "This is not korvi-pos-platform. Refusing to patch an unexpected repository."

# Strike 1 markers. Their absence means the baseline is not what this script was
# written against, and guessing would be worse than stopping.
for required in \
  packages/domain/src/money/money.ts \
  packages/domain/src/quantity/quantity.ts \
  packages/domain/src/pricing/line.ts \
  packages/domain/src/sale/finalize.ts \
  packages/domain/src/rbac/permissions.ts \
  packages/domain/src/shift/shift.ts \
  packages/domain/src/ports/persistence.ts \
  packages/database/prisma/schema.prisma \
  packages/database/src/tenant-context.ts \
  packages/database/prisma/migrations/00000000000000_rls_foundation/migration.sql
do
  [ -f "$required" ] || die "Baseline file missing: $required
     This patch expects Phase 0 + Strike 1 Domain Core (main @ a403aee)."
done

grep -q "export async function withTenant" packages/database/src/tenant-context.ts \
  || die "withTenant() not found; baseline mismatch."
grep -q "QUANTITY_SCALE" packages/domain/src/quantity/quantity.ts \
  || die "quantity module not found; baseline mismatch."

if [ "$ALLOW_DIRTY" -eq 0 ]; then
  DIRTY="$(git status --porcelain -- packages/database packages/domain/src/ports 2>/dev/null || true)"
  if [ -n "$DIRTY" ]; then
    printf '%s\n' "$DIRTY" | sed 's/^/     /' >&2
    die "Uncommitted changes under packages/database or packages/domain/src/ports.
     Commit or stash them first, or re-run with --allow-dirty if you are sure."
  fi
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" = "24" ] || die "Node 24 LTS required (ADR-0007). Found $(node --version)."

ok "Baseline verified · Node $(node --version) · $(git rev-parse --short HEAD)"

REF_DESIGN_SUM="$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)"
REF_STRAT_SUM="$(cksum < docs/governance/Korvi_POS_Master_Strategy_Document.txt)"

MIGRATION_DIR="packages/database/prisma/migrations/20260808120000_saas_foundation"
mkdir -p \
  "$MIGRATION_DIR" \
  packages/database/src/repositories \
  packages/database/src/__tests__ \
  packages/domain/src/ports/__tests__

say "Prisma schema"

cat << 'EOF' > packages/database/prisma/schema.prisma
// Korvi POS — SaaS data model.
//
// Rules that hold across every model here:
//
//   Tenancy   Every tenant-owned model carries tenantId, indexes it first in
//             every composite index, and is protected by RLS (ADR-0004). The
//             two exceptions are named and justified at the bottom of the file.
//
//   Money     BIGINT halalas. Never Float, never Decimal (ADR-0002).
//
//   Quantity  BIGINT scaled by 1000. A grocery scale reads 0.125 kg, and a
//             float weight multiplied by a price in halalas drifts exactly as
//             a float price does.
//
//   Rates     INTEGER basis points, 0..10000, constrained in the migration.
//
//   History   Finalized sales and invoices snapshot the description, price and
//             tax rate that applied at the moment of sale. Editing a product
//             tomorrow must not rewrite what yesterday's invoice says.
//
//   Ids       UUID columns, populated with UUIDv7 by the application so rows
//             sort in creation order (ADR-0003). No database default: an id
//             minted by the terminal offline must survive replay unchanged.

generator client {
  provider = "prisma-client"
  output   = "../generated/client"
}

datasource db {
  provider = "postgresql"
}

// ---------------------------------------------------------------------------
// Tenancy, identity and configuration
// ---------------------------------------------------------------------------

model Tenant {
  id        String   @id @db.Uuid
  name      String
  slug      String   @unique
  vatNumber String?  @db.VarChar(15)
  status    String   @default("active")
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Every tenant-owned model points back here, which is exactly the point:
  // if a new model has no line in this list, it has no tenant, and the RLS
  // test will refuse it.
  branches           Branch[]
  users              User[]
  memberships        TenantMembership[]
  roles              Role[]
  rolePermissions    RolePermission[]
  userRoles          UserRole[]
  terminals          Terminal[]
  settings           TenantSettings?
  categories         Category[]
  products           Product[]
  productBarcodes    ProductBarcode[]
  productPrices      ProductPrice[]
  inventoryBalances  InventoryBalance[]
  inventoryMovements InventoryMovement[]
  customers          Customer[]
  shifts             Shift[]
  cashMovements      CashMovement[]
  sales              Sale[]
  saleLines          SaleLine[]
  saleDiscounts      SaleDiscount[]
  tenders            Tender[]
  invoices           Invoice[]
  taxBreakdown       InvoiceTaxBreakdown[]
  returns            Return[]
  returnLines        ReturnLine[]
  refunds            Refund[]
  idempotencyKeys    IdempotencyKey[]
  auditEvents        AuditEvent[]

  @@map("tenants")
}

model Branch {
  id        String   @id @db.Uuid
  tenantId  String   @db.Uuid
  code      String
  nameAr    String
  nameEn    String?
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant             Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  terminals          Terminal[]
  inventoryBalances  InventoryBalance[]
  inventoryMovements InventoryMovement[]
  shifts             Shift[]
  sales              Sale[]
  returns            Return[]
  memberships        TenantMembership[]

  @@unique([tenantId, code])
  @@index([tenantId, isActive])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("branches")
}

model User {
  id           String   @id @db.Uuid
  tenantId     String   @db.Uuid
  email        String
  displayName  String
  /// Hash only. A plaintext or reversible credential must never reach a column.
  passwordHash String?
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  tenant      Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  memberships TenantMembership[]
  roles       UserRole[]
  shifts      Shift[]
  sales       Sale[]
  auditEvents AuditEvent[]

  @@unique([tenantId, email])
  @@index([tenantId, isActive])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("users")
}

/// The user's standing within a tenant, and the branch they default to.
model TenantMembership {
  id              String   @id @db.Uuid
  tenantId        String   @db.Uuid
  userId          String   @db.Uuid
  defaultBranchId String?  @db.Uuid
  status          String   @default("active")
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  tenant        Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user          User    @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: Cascade)
  defaultBranch Branch? @relation(fields: [tenantId, defaultBranchId], references: [tenantId, id], onDelete: NoAction)

  @@unique([tenantId, userId])
  @@index([tenantId, status])
  @@map("tenant_memberships")
}

/// Roles are per tenant so a merchant can define their own beyond the defaults.
model Role {
  id          String   @id @db.Uuid
  tenantId    String   @db.Uuid
  key         String
  nameAr      String
  nameEn      String?
  /// Ceiling this role may discount, in basis points of the undiscounted cart.
  maxDiscountBasisPoints Int @default(0)
  isSystem    Boolean  @default(false)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant      Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  permissions RolePermission[]
  users       UserRole[]

  @@unique([tenantId, key])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("roles")
}

model RolePermission {
  id           String @id @db.Uuid
  tenantId     String @db.Uuid
  roleId       String @db.Uuid
  permissionKey String

  tenant     Tenant     @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  role       Role       @relation(fields: [tenantId, roleId], references: [tenantId, id], onDelete: Cascade)
  permission Permission @relation(fields: [permissionKey], references: [key], onDelete: Restrict)

  @@unique([tenantId, roleId, permissionKey])
  @@index([tenantId, roleId])
  @@map("role_permissions")
}

model UserRole {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  userId   String @db.Uuid
  roleId   String @db.Uuid

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user   User   @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: Cascade)
  role   Role   @relation(fields: [tenantId, roleId], references: [tenantId, id], onDelete: Cascade)

  @@unique([tenantId, userId, roleId])
  @@index([tenantId, userId])
  @@map("user_roles")
}

model Terminal {
  id         String   @id @db.Uuid
  tenantId   String   @db.Uuid
  branchId   String   @db.Uuid
  code       String
  label      String
  /// Stable browser/device fingerprint, so a till can be recognised on return.
  deviceKey  String?
  isActive   Boolean  @default(true)
  lastSeenAt DateTime?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  tenant Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch Branch  @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: Cascade)
  shifts Shift[]
  sales  Sale[]

  @@unique([tenantId, code])
  @@index([tenantId, branchId, isActive])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("terminals")
}

/// Vertical behaviour per tenant. One merchant's grocery settings must never
/// become another merchant's restaurant defaults.
model TenantSettings {
  tenantId String @id @db.Uuid

  vertical           String  @default("retail")
  priceMode          String  @default("tax-inclusive")
  defaultVatBasisPoints Int  @default(1500)
  currency           String  @default("SAR")

  enableProductImages Boolean @default(false)
  requireBarcode      Boolean @default(true)
  allowWeightedItems  Boolean @default(false)
  trackInventory      Boolean @default(true)
  allowNegativeStock  Boolean @default(false)

  receiptHeaderAr String?
  receiptFooterAr String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@map("tenant_settings")
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

model Category {
  id        String   @id @db.Uuid
  tenantId  String   @db.Uuid
  nameAr    String
  nameEn    String?
  sortOrder Int      @default(0)
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant   Tenant    @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  products Product[]

  @@unique([tenantId, nameAr])
  @@index([tenantId, isActive, sortOrder])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("categories")
}

model Product {
  id         String  @id @db.Uuid
  tenantId   String  @db.Uuid
  categoryId String? @db.Uuid

  sku    String
  nameAr String
  nameEn String?

  /// 'unit' sells whole items; 'weighted' sells by scale reading.
  productType String @default("unit")
  unitLabel   String @default("each")

  /// Halalas per unit, in the tenant's price mode. Never Float.
  priceMinor     BigInt
  vatBasisPoints Int    @default(1500)

  /// The Phase 0 single-barcode column. Superseded by ProductBarcode, kept
  /// because dropping it would destroy data that has not been migrated yet.
  /// Nothing reads it: the repository resolves barcodes through the child
  /// table. It goes when a migration has moved every row.
  barcode String?

  /// Reversed primary barcode, so a suffix query becomes a prefix query.
  codeReverse String?
  imageUrl    String?

  trackInventory Boolean @default(true)
  isActive       Boolean @default(true)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant             Tenant              @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  category           Category?           @relation(fields: [tenantId, categoryId], references: [tenantId, id], onDelete: NoAction)
  barcodes           ProductBarcode[]
  prices             ProductPrice[]
  inventoryBalances  InventoryBalance[]
  inventoryMovements InventoryMovement[]
  saleLines          SaleLine[]

  @@unique([tenantId, sku])
  @@index([tenantId, isActive])
  @@index([tenantId, barcode])
  @@index([tenantId, categoryId])
  @@index([tenantId, codeReverse])
  @@index([tenantId, nameAr])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("products")
}

model ProductBarcode {
  id        String   @id @db.Uuid
  tenantId  String   @db.Uuid
  productId String   @db.Uuid
  barcode   String
  isPrimary Boolean  @default(false)
  createdAt DateTime @default(now())

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: Cascade)

  /// Unique within a tenant, not globally: two merchants may legitimately
  /// carry the same EAN, and a global constraint would make the second one
  /// fail to onboard.
  @@unique([tenantId, barcode])
  @@index([tenantId, productId])
  @@map("product_barcodes")
}

/// Price history. A finalized sale never reads this table -- it snapshots the
/// figure it charged -- but a price change must leave a trail.
model ProductPrice {
  id             String    @id @db.Uuid
  tenantId       String    @db.Uuid
  productId      String    @db.Uuid
  priceMinor     BigInt
  vatBasisPoints Int
  effectiveFrom  DateTime
  effectiveTo    DateTime?
  createdAt      DateTime  @default(now())

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: Cascade)

  @@index([tenantId, productId, effectiveFrom])
  @@map("product_prices")
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/// The natural key is the primary key. A surrogate id would let a second
/// balance row for the same product exist without violating anything, and two
/// disagreeing stock figures is worse than none.
model InventoryBalance {
  tenantId  String @db.Uuid
  branchId  String @db.Uuid
  productId String @db.Uuid
  /// Scaled by 1000, signed: a negative balance is oversell, which the tenant
  /// may or may not permit.
  quantityScaled BigInt @default(0)
  updatedAt DateTime @updatedAt

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch  Branch  @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: Cascade)
  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: Cascade)

  @@id([tenantId, branchId, productId])
  @@index([tenantId, branchId])
  @@map("inventory_balances")
}

model InventoryMovement {
  id        String   @id @db.Uuid
  tenantId  String   @db.Uuid
  branchId  String   @db.Uuid
  productId String   @db.Uuid

  /// 'sale' | 'return' | 'adjustment' | 'receipt' | 'transfer'
  kind           String
  quantityScaled BigInt
  reason         String?

  /// The sale or return that caused it, when there was one.
  sourceType String?
  sourceId   String? @db.Uuid

  actorUserId String?  @db.Uuid
  occurredAt  DateTime
  createdAt   DateTime @default(now())

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch  Branch  @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: Cascade)
  product Product @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: NoAction)

  @@index([tenantId, branchId, productId, occurredAt])
  @@index([tenantId, sourceType, sourceId])
  @@map("inventory_movements")
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

model Customer {
  id        String   @id @db.Uuid
  tenantId  String   @db.Uuid
  nameAr    String
  nameEn    String?
  phone     String?
  email     String?
  vatNumber String?  @db.VarChar(15)
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sales  Sale[]

  @@unique([tenantId, phone])
  @@index([tenantId, isActive])
  @@index([tenantId, nameAr])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("customers")
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

model Shift {
  id         String   @id @db.Uuid
  tenantId   String   @db.Uuid
  branchId   String   @db.Uuid
  terminalId String   @db.Uuid
  userId     String   @db.Uuid

  status            String    @default("open")
  openingFloatMinor BigInt
  declaredCashMinor BigInt?
  expectedCashMinor BigInt?
  varianceMinor     BigInt?

  openedAt DateTime
  closedAt DateTime?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  tenant        Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch        Branch         @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: Cascade)
  terminal      Terminal       @relation(fields: [tenantId, terminalId], references: [tenantId, id], onDelete: NoAction)
  user          User           @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: NoAction)
  cashMovements CashMovement[]
  sales         Sale[]

  @@index([tenantId, branchId, status])
  @@index([tenantId, terminalId, status])
  @@index([tenantId, openedAt])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("shifts")
}

model CashMovement {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  shiftId  String @db.Uuid

  /// 'sale' | 'refund' | 'pay-in' | 'pay-out' | 'opening-float'
  kind String
  /// Signed halalas: a pay-out and a refund are negative, matching the domain.
  amountMinor BigInt
  reason      String?

  actorUserId String?  @db.Uuid
  occurredAt  DateTime
  createdAt   DateTime @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  shift  Shift  @relation(fields: [tenantId, shiftId], references: [tenantId, id], onDelete: Cascade)

  @@index([tenantId, shiftId, occurredAt])
  @@map("cash_movements")
}
EOF

cat << 'EOF' >> packages/database/prisma/schema.prisma

// ---------------------------------------------------------------------------
// Sales — immutable once finalized
// ---------------------------------------------------------------------------

model Sale {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  branchId String @db.Uuid
  terminalId String @db.Uuid
  shiftId    String @db.Uuid
  userId     String @db.Uuid
  customerId String? @db.Uuid

  /// The client-supplied operation id. Unique per tenant, which is what makes
  /// a double-click, a network retry and an offline replay converge on one
  /// sale rather than three.
  operationId String

  status   String @default("finalized")
  sequence Int

  /// Every figure the receipt states, snapshotted. Recomputing from products
  /// later would produce a different answer after any price change.
  priceMode        String
  currency         String @default("SAR")
  grossMinor       BigInt
  lineDiscountMinor  BigInt
  basketDiscountMinor BigInt
  netMinor         BigInt
  vatMinor         BigInt
  totalMinor       BigInt
  tenderedMinor    BigInt
  changeMinor      BigInt

  issuedAt  DateTime
  createdAt DateTime @default(now())

  tenant    Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  branch    Branch         @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: NoAction)
  terminal  Terminal       @relation(fields: [tenantId, terminalId], references: [tenantId, id], onDelete: NoAction)
  shift     Shift          @relation(fields: [tenantId, shiftId], references: [tenantId, id], onDelete: NoAction)
  user      User           @relation(fields: [tenantId, userId], references: [tenantId, id], onDelete: NoAction)
  customer  Customer?      @relation(fields: [tenantId, customerId], references: [tenantId, id], onDelete: NoAction)
  lines     SaleLine[]
  discounts SaleDiscount[]
  tenders   Tender[]
  invoice   Invoice?
  returns   Return[]

  @@unique([tenantId, operationId])
  @@unique([tenantId, branchId, sequence])
  @@index([tenantId, branchId, issuedAt])
  @@index([tenantId, shiftId])
  @@index([tenantId, status, issuedAt])
  @@index([tenantId, customerId])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("sales")
}

model SaleLine {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  saleId   String @db.Uuid

  /// Kept for reporting, but nothing on this row is read back from it.
  productId String? @db.Uuid
  lineNumber Int

  /// Snapshot: what this product was called and cost at the moment of sale.
  sku            String
  nameAr         String
  nameEn         String?
  unitPriceMinor BigInt
  vatBasisPoints Int
  quantityScaled BigInt

  grossMinor          BigInt
  lineDiscountMinor   BigInt
  basketDiscountMinor BigInt
  netMinor            BigInt
  vatMinor            BigInt
  totalMinor          BigInt

  tenant     Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale       Sale         @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: Cascade)
  product    Product?     @relation(fields: [tenantId, productId], references: [tenantId, id], onDelete: NoAction)
  returnLines ReturnLine[]

  @@unique([tenantId, saleId, lineNumber])
  @@index([tenantId, saleId])
  @@index([tenantId, productId])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("sale_lines")
}

model SaleDiscount {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  saleId   String @db.Uuid

  /// 'line' | 'basket'
  scope      String
  lineNumber Int?
  /// 'fixed' | 'percentage'
  kind        String
  /// Halalas for fixed, basis points for percentage -- as entered.
  inputValue  BigInt
  /// Halalas actually granted after allocation.
  amountMinor BigInt
  reason      String?
  grantedByUserId String? @db.Uuid

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale   Sale   @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: Cascade)

  @@index([tenantId, saleId])
  @@map("sale_discounts")
}

model Tender {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  saleId   String @db.Uuid

  /// 'cash' | 'card' | 'mada' | 'transfer'
  kind        String
  amountMinor BigInt
  /// Only cash can carry this above zero (ADR-0002).
  changeMinor BigInt @default(0)
  reference   String?

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale   Sale   @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: Cascade)

  @@index([tenantId, saleId])
  @@index([tenantId, kind])
  @@map("tenders")
}

// ---------------------------------------------------------------------------
// Invoices — the tax document, never rewritten
// ---------------------------------------------------------------------------

model Invoice {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  saleId   String @db.Uuid @unique

  invoiceNumber String
  /// 'simplified' | 'standard'
  invoiceType   String @default("simplified")

  /// Seller identity as it stood when the invoice was issued. A merchant who
  /// changes their registered name next year must not alter last year's tax
  /// documents.
  sellerName      String
  sellerVatNumber String  @db.VarChar(15)
  buyerName       String?
  buyerVatNumber  String? @db.VarChar(15)

  netMinor   BigInt
  vatMinor   BigInt
  totalMinor BigInt
  currency   String @default("SAR")

  issuedAt  DateTime
  createdAt DateTime @default(now())

  tenant        Tenant                 @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale          Sale                   @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: NoAction)
  taxBreakdown  InvoiceTaxBreakdown[]
  refunds       Refund[]

  @@unique([tenantId, invoiceNumber])
  /// The relation key for the one-to-one back to the sale. `saleId` is already
  /// globally unique, so this adds no constraint the data did not have — it
  /// states the pair the composite foreign key references.
  @@unique([tenantId, saleId])
  @@index([tenantId, issuedAt])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("invoices")
}

/// One row per distinct VAT rate on the invoice. The Authority wants the split,
/// not just the sum.
model InvoiceTaxBreakdown {
  id        String @id @db.Uuid
  tenantId  String @db.Uuid
  invoiceId String @db.Uuid

  vatBasisPoints Int
  netMinor       BigInt
  vatMinor       BigInt

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  invoice Invoice @relation(fields: [tenantId, invoiceId], references: [tenantId, id], onDelete: Cascade)

  @@unique([tenantId, invoiceId, vatBasisPoints])
  @@index([tenantId, invoiceId])
  @@map("invoice_tax_breakdown")
}

// ---------------------------------------------------------------------------
// Returns — new records, never edits to the original
// ---------------------------------------------------------------------------

model Return {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  saleId   String @db.Uuid
  branchId String @db.Uuid

  operationId String
  status      String @default("finalized")
  reason      String?

  netMinor   BigInt
  vatMinor   BigInt
  totalMinor BigInt

  actorUserId String   @db.Uuid
  issuedAt    DateTime
  createdAt   DateTime @default(now())

  tenant  Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  sale    Sale         @relation(fields: [tenantId, saleId], references: [tenantId, id], onDelete: NoAction)
  branch  Branch       @relation(fields: [tenantId, branchId], references: [tenantId, id], onDelete: NoAction)
  lines   ReturnLine[]
  refunds Refund[]

  @@unique([tenantId, operationId])
  @@index([tenantId, saleId])
  @@index([tenantId, issuedAt])
  /// The tenant-consistency key. A child row references this table by
  /// (tenantId, id), not by id alone, so PostgreSQL itself refuses a
  /// reference that crosses tenants (ADR-0004).
  @@unique([tenantId, id])
  @@map("returns")
}

model ReturnLine {
  id         String @id @db.Uuid
  tenantId   String @db.Uuid
  returnId   String @db.Uuid
  saleLineId String @db.Uuid

  quantityScaled BigInt
  netMinor       BigInt
  vatMinor       BigInt
  totalMinor     BigInt

  tenant   Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  return   Return   @relation(fields: [tenantId, returnId], references: [tenantId, id], onDelete: Cascade)
  saleLine SaleLine @relation(fields: [tenantId, saleLineId], references: [tenantId, id], onDelete: NoAction)

  @@index([tenantId, returnId])
  @@index([tenantId, saleLineId])
  @@map("return_lines")
}

model Refund {
  id       String @id @db.Uuid
  tenantId String @db.Uuid
  returnId String @db.Uuid
  invoiceId String? @db.Uuid

  /// 'cash' | 'card' | 'mada' | 'transfer'
  method      String
  amountMinor BigInt
  reference   String?

  issuedAt  DateTime
  createdAt DateTime @default(now())

  tenant  Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  return  Return   @relation(fields: [tenantId, returnId], references: [tenantId, id], onDelete: Cascade)
  invoice Invoice? @relation(fields: [tenantId, invoiceId], references: [tenantId, id], onDelete: NoAction)

  @@index([tenantId, returnId])
  @@map("refunds")
}

// ---------------------------------------------------------------------------
// Idempotency and audit
// ---------------------------------------------------------------------------

/// Reservation record for a replayable operation.
///
/// The unique key is (tenantId, scope, operationId): the same checkout retried
/// after a dropped connection reserves the same row, finds it already
/// completed, and returns the recorded result instead of ringing up a second
/// sale.
model IdempotencyKey {
  id       String @id @db.Uuid
  tenantId String @db.Uuid

  /// 'checkout' | 'return' | 'shift-close' ...
  scope       String
  operationId String

  /// 'reserved' | 'completed' | 'failed'
  status String @default("reserved")

  /// What the operation produced, so a retry can be answered without redoing
  /// the work. Never contains credentials.
  resultType String?
  resultId   String? @db.Uuid

  /// Fingerprint of the request body, so a replay carrying different content
  /// under the same operation id is detected rather than silently accepted.
  requestHash String?

  createdAt   DateTime  @default(now())
  completedAt DateTime?
  expiresAt   DateTime?

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, scope, operationId])
  @@index([tenantId, status])
  @@index([expiresAt])
  @@map("idempotency_keys")
}

/// Append-only. Nothing updates or deletes an audit row.
model AuditEvent {
  id       String @id @db.Uuid
  tenantId String @db.Uuid

  actorUserId String? @db.Uuid
  branchId    String? @db.Uuid
  terminalId  String? @db.Uuid

  eventType  String
  entityType String
  entityId   String?

  /// Structured context. Never credentials, tokens or password material.
  metadata Json?

  occurredAt DateTime
  createdAt  DateTime @default(now())

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  actor  User?  @relation(fields: [tenantId, actorUserId], references: [tenantId, id], onDelete: NoAction)

  @@index([tenantId, occurredAt])
  @@index([tenantId, entityType, entityId])
  @@index([tenantId, eventType, occurredAt])
  @@map("audit_events")
}

// ---------------------------------------------------------------------------
// Global reference data — the only tables without tenantId
// ---------------------------------------------------------------------------

/// The permission catalogue.
///
/// Global because it is the application's own vocabulary, identical for every
/// tenant and not derived from anyone's data. Tenants bind these keys to their
/// own roles through RolePermission, which is tenant-owned.
model Permission {
  key         String   @id
  descriptionAr String
  descriptionEn String?
  createdAt   DateTime @default(now())

  roles RolePermission[]

  @@map("permissions")
}

/// The national barcode catalogue.
///
/// Shared infrastructure: hundreds of thousands of rows identical for every
/// merchant, none of it anyone's private data. Copying it per tenant would
/// multiply the table by the customer count for no isolation benefit
/// (ADR-0004).
model GlobalCatalogItem {
  barcode        String   @id
  nameAr         String
  nameEn         String?
  vatBasisPoints Int      @default(1500)
  updatedAt      DateTime @updatedAt

  @@map("global_catalog_items")
}
EOF

say "RLS migration"

cat << 'SQLEOF' > "$MIGRATION_DIR/migration.sql"
-- Korvi POS — Strike 2A: SaaS foundation.
--
-- Forward only. This migration creates the new tables and extends Row-Level
-- Security to every one of them. It drops nothing and rewrites no data: the
-- Phase 0 tables (tenants, products, global_catalog_items) already exist, so
-- the new columns are added rather than the tables recreated.
--
-- The tenancy model is unchanged from ADR-0004. `current_tenant_id()` reads
-- `app.tenant_id`, which `withTenant()` establishes with SET LOCAL inside the
-- transaction. That is the single tenancy mechanism; nothing here introduces a
-- weaker second one.
--
-- Every tenant-owned table below gets ENABLE + FORCE and one policy carrying
-- both USING and WITH CHECK. FORCE is the part usually missed: without it the
-- table owner bypasses every policy, and the application role is very often
-- the owner. USING alone would govern reads only, leaving an UPDATE free to
-- reassign a visible row to another tenant.
--
-- Tenant-consistent foreign keys
-- -----------------------------
-- RLS protects a row. It does not protect a *reference*: a sale owned by
-- tenant A, visible only to A, could still name a branch owned by tenant B,
-- because a plain foreign key to branches(id) proves the branch exists and
-- nothing else. The result reads correctly to A — right up to the point where
-- a report joins through it.
--
-- Every tenant-owned parent therefore carries a unique key on
-- ("tenantId", "id"), and every child references that pair rather than the id
-- alone. The child's own "tenantId" appears on both sides of the reference, so
-- PostgreSQL rejects a cross-tenant parent at INSERT and at UPDATE, without a
-- trigger, a check function, or anything the application can forget.
--
-- The cost is the delete action on the nullable references. ON DELETE SET NULL
-- would null every column of the composite key, "tenantId" included, and that
-- column is NOT NULL. Those references therefore refuse the delete instead of
-- nulling it: the column stays nullable, but a category, customer, product,
-- invoice or user that is still referenced cannot be deleted. For records a
-- tax authority may ask about that is the better answer anyway, and every one
-- of these tables carries an isActive flag for what the merchant usually means.
--
-- The refusing action is NO ACTION rather than RESTRICT, and the difference
-- matters exactly once: deleting a tenant. RESTRICT is checked immediately, so
-- it fires even when the referencing row is being deleted by the same
-- statement — which is precisely what tenant offboarding does, cascading from
-- tenants into all 29 tables at once. NO ACTION defers the check to the end of
-- the statement, so a dangling reference is still an error and a wholesale
-- cascade still succeeds.
--
-- Reference to a global table (permissions, global_catalog_items) stays a
-- single-column key: those rows have no tenant to be consistent with.

-- ---------------------------------------------------------------------------
-- Phase 0 tables: additive changes only
-- ---------------------------------------------------------------------------

ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "slug" TEXT;
UPDATE "tenants" SET "slug" = "id"::text WHERE "slug" IS NULL;
ALTER TABLE "tenants" ALTER COLUMN "slug" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_key" ON "tenants"("slug");
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'active';

ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "categoryId" UUID;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "productType" TEXT NOT NULL DEFAULT 'unit';
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "unitLabel" TEXT NOT NULL DEFAULT 'each';
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "imageUrl" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "trackInventory" BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT TRUE;
-- The single `barcode` column becomes the product_barcodes table; the column is
-- kept so existing rows are not lost, and is migrated by application tooling.
CREATE INDEX IF NOT EXISTS "products_tenantId_isActive_idx" ON "products"("tenantId", "isActive");
CREATE INDEX IF NOT EXISTS "products_tenantId_nameAr_idx" ON "products"("tenantId", "nameAr");
-- The tenant-consistency key on the Phase 0 catalogue table. Every child that
-- points at a product points at (tenantId, id), so a barcode, a price row or a
-- sale line cannot name a product belonging to another merchant.
CREATE UNIQUE INDEX IF NOT EXISTS "products_tenantId_id_key" ON "products"("tenantId", "id");
CREATE INDEX IF NOT EXISTS "products_tenantId_categoryId_idx" ON "products"("tenantId", "categoryId");

ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_tenantId_fkey";
ALTER TABLE "products" ADD CONSTRAINT "products_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- New tables
-- ---------------------------------------------------------------------------

CREATE TABLE "branches" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "branches_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "branches_tenantId_id_key" ON "branches"("tenantId", "id");
CREATE UNIQUE INDEX "branches_tenantId_code_key" ON "branches"("tenantId", "code");
CREATE INDEX "branches_tenantId_isActive_idx" ON "branches"("tenantId", "isActive");

CREATE TABLE "users" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "passwordHash" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "users_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "users_tenantId_id_key" ON "users"("tenantId", "id");
CREATE UNIQUE INDEX "users_tenantId_email_key" ON "users"("tenantId", "email");
CREATE INDEX "users_tenantId_isActive_idx" ON "users"("tenantId", "isActive");

CREATE TABLE "tenant_memberships" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "defaultBranchId" UUID,
  "status" TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_memberships_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenant_memberships_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenant_memberships_tenantId_defaultBranchId_fkey" FOREIGN KEY ("tenantId", "defaultBranchId") REFERENCES "branches"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "tenant_memberships_tenantId_userId_key" ON "tenant_memberships"("tenantId", "userId");
CREATE INDEX "tenant_memberships_tenantId_status_idx" ON "tenant_memberships"("tenantId", "status");

CREATE TABLE "permissions" (
  "key" TEXT PRIMARY KEY,
  "descriptionAr" TEXT NOT NULL,
  "descriptionEn" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "roles" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "maxDiscountBasisPoints" INTEGER NOT NULL DEFAULT 0,
  "isSystem" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "roles_max_discount_range"
    CHECK ("maxDiscountBasisPoints" >= 0 AND "maxDiscountBasisPoints" <= 10000),
  CONSTRAINT "roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "roles_tenantId_id_key" ON "roles"("tenantId", "id");
CREATE UNIQUE INDEX "roles_tenantId_key_key" ON "roles"("tenantId", "key");

CREATE TABLE "role_permissions" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  "permissionKey" TEXT NOT NULL,
  CONSTRAINT "role_permissions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "role_permissions_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "roles"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "role_permissions_permissionKey_fkey" FOREIGN KEY ("permissionKey") REFERENCES "permissions"("key") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "role_permissions_tenantId_roleId_permissionKey_key"
  ON "role_permissions"("tenantId", "roleId", "permissionKey");
CREATE INDEX "role_permissions_tenantId_roleId_idx" ON "role_permissions"("tenantId", "roleId");

CREATE TABLE "user_roles" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "roleId" UUID NOT NULL,
  CONSTRAINT "user_roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_roles_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_roles_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "roles"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "user_roles_tenantId_userId_roleId_key" ON "user_roles"("tenantId", "userId", "roleId");
CREATE INDEX "user_roles_tenantId_userId_idx" ON "user_roles"("tenantId", "userId");

CREATE TABLE "terminals" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "deviceKey" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "terminals_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "terminals_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "terminals_tenantId_id_key" ON "terminals"("tenantId", "id");
CREATE UNIQUE INDEX "terminals_tenantId_code_key" ON "terminals"("tenantId", "code");
CREATE INDEX "terminals_tenantId_branchId_isActive_idx" ON "terminals"("tenantId", "branchId", "isActive");

CREATE TABLE "tenant_settings" (
  "tenantId" UUID PRIMARY KEY,
  "vertical" TEXT NOT NULL DEFAULT 'retail',
  "priceMode" TEXT NOT NULL DEFAULT 'tax-inclusive',
  "defaultVatBasisPoints" INTEGER NOT NULL DEFAULT 1500,
  "currency" TEXT NOT NULL DEFAULT 'SAR',
  "enableProductImages" BOOLEAN NOT NULL DEFAULT FALSE,
  "requireBarcode" BOOLEAN NOT NULL DEFAULT TRUE,
  "allowWeightedItems" BOOLEAN NOT NULL DEFAULT FALSE,
  "trackInventory" BOOLEAN NOT NULL DEFAULT TRUE,
  "allowNegativeStock" BOOLEAN NOT NULL DEFAULT FALSE,
  "receiptHeaderAr" TEXT,
  "receiptFooterAr" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tenant_settings_vat_range"
    CHECK ("defaultVatBasisPoints" >= 0 AND "defaultVatBasisPoints" <= 10000),
  CONSTRAINT "tenant_settings_price_mode"
    CHECK ("priceMode" IN ('tax-inclusive', 'tax-exclusive')),
  CONSTRAINT "tenant_settings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "categories" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "categories_tenantId_id_key" ON "categories"("tenantId", "id");
CREATE UNIQUE INDEX "categories_tenantId_nameAr_key" ON "categories"("tenantId", "nameAr");
CREATE INDEX "categories_tenantId_isActive_sortOrder_idx" ON "categories"("tenantId", "isActive", "sortOrder");

ALTER TABLE "products"
  ADD CONSTRAINT "products_tenantId_categoryId_fkey"
  FOREIGN KEY ("tenantId", "categoryId") REFERENCES "categories"("tenantId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "products"
  ADD CONSTRAINT "products_product_type"
  CHECK ("productType" IN ('unit', 'weighted'));

CREATE TABLE "product_barcodes" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "barcode" TEXT NOT NULL,
  "isPrimary" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_barcodes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_barcodes_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Unique within a tenant, not globally: two merchants may legitimately carry
-- the same EAN, and a global constraint would block the second onboarding.
CREATE UNIQUE INDEX "product_barcodes_tenantId_barcode_key" ON "product_barcodes"("tenantId", "barcode");
CREATE INDEX "product_barcodes_tenantId_productId_idx" ON "product_barcodes"("tenantId", "productId");

CREATE TABLE "product_prices" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "priceMinor" BIGINT NOT NULL,
  "vatBasisPoints" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "product_prices_non_negative" CHECK ("priceMinor" >= 0),
  CONSTRAINT "product_prices_vat_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000),
  CONSTRAINT "product_prices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "product_prices_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "product_prices_tenantId_productId_effectiveFrom_idx"
  ON "product_prices"("tenantId", "productId", "effectiveFrom");

-- The natural key is the primary key: there is exactly one balance per
-- (tenant, branch, product), and giving the row a surrogate id would invite a
-- second balance for the same product to exist without violating anything.
CREATE TABLE "inventory_balances" (
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("tenantId", "branchId", "productId"),
  CONSTRAINT "inventory_balances_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_balances_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_balances_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "inventory_balances_tenantId_branchId_idx" ON "inventory_balances"("tenantId", "branchId");

CREATE TABLE "inventory_movements" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "reason" TEXT,
  "sourceType" TEXT,
  "sourceId" UUID,
  "actorUserId" UUID,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_movements_kind"
    CHECK ("kind" IN ('sale', 'return', 'adjustment', 'receipt', 'transfer')),
  CONSTRAINT "inventory_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_movements_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_movements_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "inventory_movements_tenantId_branchId_productId_occurredAt_idx"
  ON "inventory_movements"("tenantId", "branchId", "productId", "occurredAt");
CREATE INDEX "inventory_movements_tenantId_sourceType_sourceId_idx"
  ON "inventory_movements"("tenantId", "sourceType", "sourceId");

CREATE TABLE "customers" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "vatNumber" VARCHAR(15),
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "customers_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "customers_tenantId_id_key" ON "customers"("tenantId", "id");
CREATE UNIQUE INDEX "customers_tenantId_phone_key" ON "customers"("tenantId", "phone");
CREATE INDEX "customers_tenantId_isActive_idx" ON "customers"("tenantId", "isActive");
CREATE INDEX "customers_tenantId_nameAr_idx" ON "customers"("tenantId", "nameAr");

CREATE TABLE "shifts" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'open',
  "openingFloatMinor" BIGINT NOT NULL,
  "declaredCashMinor" BIGINT,
  "expectedCashMinor" BIGINT,
  "varianceMinor" BIGINT,
  "openedAt" TIMESTAMP(3) NOT NULL,
  "closedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "shifts_status" CHECK ("status" IN ('open', 'closed')),
  CONSTRAINT "shifts_opening_float_non_negative" CHECK ("openingFloatMinor" >= 0),
  CONSTRAINT "shifts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shifts_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "shifts_tenantId_terminalId_fkey" FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "shifts_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "shifts_tenantId_id_key" ON "shifts"("tenantId", "id");
CREATE INDEX "shifts_tenantId_branchId_status_idx" ON "shifts"("tenantId", "branchId", "status");
CREATE INDEX "shifts_tenantId_terminalId_status_idx" ON "shifts"("tenantId", "terminalId", "status");
CREATE INDEX "shifts_tenantId_openedAt_idx" ON "shifts"("tenantId", "openedAt");

CREATE TABLE "cash_movements" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "shiftId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "reason" TEXT,
  "actorUserId" UUID,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cash_movements_kind"
    CHECK ("kind" IN ('sale', 'refund', 'pay-in', 'pay-out', 'opening-float')),
  -- The sign carries meaning, and the domain enforces the same rule.
  CONSTRAINT "cash_movements_sign" CHECK (
    ("kind" IN ('sale', 'pay-in') AND "amountMinor" >= 0) OR
    ("kind" IN ('refund', 'pay-out') AND "amountMinor" <= 0) OR
    ("kind" = 'opening-float')
  ),
  CONSTRAINT "cash_movements_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "cash_movements_tenantId_shiftId_fkey" FOREIGN KEY ("tenantId", "shiftId") REFERENCES "shifts"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "cash_movements_tenantId_shiftId_occurredAt_idx"
  ON "cash_movements"("tenantId", "shiftId", "occurredAt");

CREATE TABLE "sales" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "terminalId" UUID NOT NULL,
  "shiftId" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "customerId" UUID,
  "operationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'finalized',
  "sequence" INTEGER NOT NULL,
  "priceMode" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'SAR',
  "grossMinor" BIGINT NOT NULL,
  "lineDiscountMinor" BIGINT NOT NULL,
  "basketDiscountMinor" BIGINT NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  "tenderedMinor" BIGINT NOT NULL,
  "changeMinor" BIGINT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sales_status" CHECK ("status" IN ('finalized', 'voided')),
  CONSTRAINT "sales_price_mode" CHECK ("priceMode" IN ('tax-inclusive', 'tax-exclusive')),
  CONSTRAINT "sales_total_positive" CHECK ("totalMinor" > 0),
  -- The reconciliation invariant, enforced by the database as well as the
  -- domain: net + vat = total, and tendered - change = total.
  CONSTRAINT "sales_reconciles" CHECK (
    "netMinor" + "vatMinor" = "totalMinor" AND
    "tenderedMinor" - "changeMinor" = "totalMinor"
  ),
  CONSTRAINT "sales_change_non_negative" CHECK ("changeMinor" >= 0),
  CONSTRAINT "sales_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_terminalId_fkey" FOREIGN KEY ("tenantId", "terminalId") REFERENCES "terminals"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_shiftId_fkey" FOREIGN KEY ("tenantId", "shiftId") REFERENCES "shifts"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_userId_fkey" FOREIGN KEY ("tenantId", "userId") REFERENCES "users"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "sales_tenantId_customerId_fkey" FOREIGN KEY ("tenantId", "customerId") REFERENCES "customers"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sales_tenantId_id_key" ON "sales"("tenantId", "id");
CREATE UNIQUE INDEX "sales_tenantId_operationId_key" ON "sales"("tenantId", "operationId");
CREATE UNIQUE INDEX "sales_tenantId_branchId_sequence_key" ON "sales"("tenantId", "branchId", "sequence");
CREATE INDEX "sales_tenantId_branchId_issuedAt_idx" ON "sales"("tenantId", "branchId", "issuedAt");
CREATE INDEX "sales_tenantId_shiftId_idx" ON "sales"("tenantId", "shiftId");
CREATE INDEX "sales_tenantId_status_issuedAt_idx" ON "sales"("tenantId", "status", "issuedAt");
CREATE INDEX "sales_tenantId_customerId_idx" ON "sales"("tenantId", "customerId");

CREATE TABLE "sale_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "productId" UUID,
  "lineNumber" INTEGER NOT NULL,
  "sku" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "nameEn" TEXT,
  "unitPriceMinor" BIGINT NOT NULL,
  "vatBasisPoints" INTEGER NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "grossMinor" BIGINT NOT NULL,
  "lineDiscountMinor" BIGINT NOT NULL,
  "basketDiscountMinor" BIGINT NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  CONSTRAINT "sale_lines_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "sale_lines_vat_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000),
  CONSTRAINT "sale_lines_reconciles" CHECK ("netMinor" + "vatMinor" = "totalMinor"),
  CONSTRAINT "sale_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_lines_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_lines_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "sale_lines_tenantId_id_key" ON "sale_lines"("tenantId", "id");
CREATE UNIQUE INDEX "sale_lines_tenantId_saleId_lineNumber_key"
  ON "sale_lines"("tenantId", "saleId", "lineNumber");
CREATE INDEX "sale_lines_tenantId_saleId_idx" ON "sale_lines"("tenantId", "saleId");
CREATE INDEX "sale_lines_tenantId_productId_idx" ON "sale_lines"("tenantId", "productId");

CREATE TABLE "sale_discounts" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "lineNumber" INTEGER,
  "kind" TEXT NOT NULL,
  "inputValue" BIGINT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "reason" TEXT,
  "grantedByUserId" UUID,
  CONSTRAINT "sale_discounts_scope" CHECK ("scope" IN ('line', 'basket')),
  CONSTRAINT "sale_discounts_kind" CHECK ("kind" IN ('fixed', 'percentage')),
  CONSTRAINT "sale_discounts_non_negative" CHECK ("amountMinor" >= 0),
  CONSTRAINT "sale_discounts_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "sale_discounts_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "sale_discounts_tenantId_saleId_idx" ON "sale_discounts"("tenantId", "saleId");

CREATE TABLE "tenders" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "changeMinor" BIGINT NOT NULL DEFAULT 0,
  "reference" TEXT,
  CONSTRAINT "tenders_kind" CHECK ("kind" IN ('cash', 'card', 'mada', 'transfer')),
  CONSTRAINT "tenders_amount_non_negative" CHECK ("amountMinor" >= 0),
  -- Only cash returns change. A card terminal has no mechanism to hand money
  -- back, so a non-zero change on a non-cash tender is a data error.
  CONSTRAINT "tenders_change_cash_only" CHECK ("changeMinor" = 0 OR "kind" = 'cash'),
  CONSTRAINT "tenders_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "tenders_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "tenders_tenantId_saleId_idx" ON "tenders"("tenantId", "saleId");
CREATE INDEX "tenders_tenantId_kind_idx" ON "tenders"("tenantId", "kind");

CREATE TABLE "invoices" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL UNIQUE,
  "invoiceNumber" TEXT NOT NULL,
  "invoiceType" TEXT NOT NULL DEFAULT 'simplified',
  "sellerName" TEXT NOT NULL,
  "sellerVatNumber" VARCHAR(15) NOT NULL,
  "buyerName" TEXT,
  "buyerVatNumber" VARCHAR(15),
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'SAR',
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "invoices_type" CHECK ("invoiceType" IN ('simplified', 'standard')),
  CONSTRAINT "invoices_reconciles" CHECK ("netMinor" + "vatMinor" = "totalMinor"),
  CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invoices_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invoices_tenantId_id_key" ON "invoices"("tenantId", "id");
CREATE UNIQUE INDEX "invoices_tenantId_saleId_key" ON "invoices"("tenantId", "saleId");
CREATE UNIQUE INDEX "invoices_tenantId_invoiceNumber_key" ON "invoices"("tenantId", "invoiceNumber");
CREATE INDEX "invoices_tenantId_issuedAt_idx" ON "invoices"("tenantId", "issuedAt");

CREATE TABLE "invoice_tax_breakdown" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "invoiceId" UUID NOT NULL,
  "vatBasisPoints" INTEGER NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  CONSTRAINT "invoice_tax_breakdown_vat_range"
    CHECK ("vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000),
  CONSTRAINT "invoice_tax_breakdown_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "invoice_tax_breakdown_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "invoice_tax_breakdown_tenantId_invoiceId_vatBasisPoints_key"
  ON "invoice_tax_breakdown"("tenantId", "invoiceId", "vatBasisPoints");
CREATE INDEX "invoice_tax_breakdown_tenantId_invoiceId_idx"
  ON "invoice_tax_breakdown"("tenantId", "invoiceId");

CREATE TABLE "returns" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "saleId" UUID NOT NULL,
  "branchId" UUID NOT NULL,
  "operationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'finalized',
  "reason" TEXT,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  "actorUserId" UUID NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "returns_reconciles" CHECK ("netMinor" + "vatMinor" = "totalMinor"),
  CONSTRAINT "returns_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "returns_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE,
  CONSTRAINT "returns_tenantId_branchId_fkey" FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "returns_tenantId_id_key" ON "returns"("tenantId", "id");
CREATE UNIQUE INDEX "returns_tenantId_operationId_key" ON "returns"("tenantId", "operationId");
CREATE INDEX "returns_tenantId_saleId_idx" ON "returns"("tenantId", "saleId");
CREATE INDEX "returns_tenantId_issuedAt_idx" ON "returns"("tenantId", "issuedAt");

CREATE TABLE "return_lines" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "returnId" UUID NOT NULL,
  "saleLineId" UUID NOT NULL,
  "quantityScaled" BIGINT NOT NULL,
  "netMinor" BIGINT NOT NULL,
  "vatMinor" BIGINT NOT NULL,
  "totalMinor" BIGINT NOT NULL,
  CONSTRAINT "return_lines_quantity_positive" CHECK ("quantityScaled" > 0),
  CONSTRAINT "return_lines_reconciles" CHECK ("netMinor" + "vatMinor" = "totalMinor"),
  CONSTRAINT "return_lines_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "return_lines_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "return_lines_tenantId_saleLineId_fkey" FOREIGN KEY ("tenantId", "saleLineId") REFERENCES "sale_lines"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "return_lines_tenantId_returnId_idx" ON "return_lines"("tenantId", "returnId");
CREATE INDEX "return_lines_tenantId_saleLineId_idx" ON "return_lines"("tenantId", "saleLineId");

CREATE TABLE "refunds" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "returnId" UUID NOT NULL,
  "invoiceId" UUID,
  "method" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "reference" TEXT,
  "issuedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refunds_method" CHECK ("method" IN ('cash', 'card', 'mada', 'transfer')),
  CONSTRAINT "refunds_amount_positive" CHECK ("amountMinor" > 0),
  CONSTRAINT "refunds_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "refunds_tenantId_returnId_fkey" FOREIGN KEY ("tenantId", "returnId") REFERENCES "returns"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "refunds_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "refunds_tenantId_returnId_idx" ON "refunds"("tenantId", "returnId");

CREATE TABLE "idempotency_keys" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "scope" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'reserved',
  "resultType" TEXT,
  "resultId" UUID,
  "requestHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  CONSTRAINT "idempotency_keys_status"
    CHECK ("status" IN ('reserved', 'completed', 'failed')),
  CONSTRAINT "idempotency_keys_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- The reservation identity. A retry of the same operation collides here rather
-- than creating a second sale.
CREATE UNIQUE INDEX "idempotency_keys_tenantId_scope_operationId_key"
  ON "idempotency_keys"("tenantId", "scope", "operationId");
CREATE INDEX "idempotency_keys_tenantId_status_idx" ON "idempotency_keys"("tenantId", "status");
CREATE INDEX "idempotency_keys_expiresAt_idx" ON "idempotency_keys"("expiresAt");

CREATE TABLE "audit_events" (
  "id" UUID PRIMARY KEY,
  "tenantId" UUID NOT NULL,
  "actorUserId" UUID,
  "branchId" UUID,
  "terminalId" UUID,
  "eventType" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "audit_events_tenantId_actorUserId_fkey" FOREIGN KEY ("tenantId", "actorUserId") REFERENCES "users"("tenantId", "id") ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX "audit_events_tenantId_occurredAt_idx" ON "audit_events"("tenantId", "occurredAt");
CREATE INDEX "audit_events_tenantId_entityType_entityId_idx" ON "audit_events"("tenantId", "entityType", "entityId");
CREATE INDEX "audit_events_tenantId_eventType_occurredAt_idx"
  ON "audit_events"("tenantId", "eventType", "occurredAt");

-- ---------------------------------------------------------------------------
-- Row-Level Security — deny by default on every tenant-owned table
-- ---------------------------------------------------------------------------
--
-- Each policy is dropped and recreated rather than created blindly. `tenants`
-- and `products` already carry a policy from the Phase 0 migration, and
-- PostgreSQL has no CREATE POLICY ... IF NOT EXISTS, so a bare CREATE would
-- abort this migration on any database that has already run Phase 0.
--
-- Recreating also means the policy body is whatever this file says, rather
-- than whatever happens to be there. If the migration were interrupted between
-- the drop and the create, the table would be left with RLS enabled and no
-- policy — which denies everything. That is the safe direction to fail.

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenants_isolation" ON "tenants";
CREATE POLICY "tenants_isolation" ON "tenants"
  USING ("id" = current_tenant_id())
  WITH CHECK ("id" = current_tenant_id());

ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "branches_isolation" ON "branches";
CREATE POLICY "branches_isolation" ON "branches"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_isolation" ON "users";
CREATE POLICY "users_isolation" ON "users"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "tenant_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_memberships_isolation" ON "tenant_memberships";
CREATE POLICY "tenant_memberships_isolation" ON "tenant_memberships"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "roles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "roles_isolation" ON "roles";
CREATE POLICY "roles_isolation" ON "roles"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permissions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "role_permissions_isolation" ON "role_permissions";
CREATE POLICY "role_permissions_isolation" ON "role_permissions"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "user_roles_isolation" ON "user_roles";
CREATE POLICY "user_roles_isolation" ON "user_roles"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "terminals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "terminals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "terminals_isolation" ON "terminals";
CREATE POLICY "terminals_isolation" ON "terminals"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_settings_isolation" ON "tenant_settings";
CREATE POLICY "tenant_settings_isolation" ON "tenant_settings"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "categories_isolation" ON "categories";
CREATE POLICY "categories_isolation" ON "categories"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "products_isolation" ON "products";
CREATE POLICY "products_isolation" ON "products"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "product_barcodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_barcodes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_barcodes_isolation" ON "product_barcodes";
CREATE POLICY "product_barcodes_isolation" ON "product_barcodes"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "product_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "product_prices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "product_prices_isolation" ON "product_prices";
CREATE POLICY "product_prices_isolation" ON "product_prices"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_balances_isolation" ON "inventory_balances";
CREATE POLICY "inventory_balances_isolation" ON "inventory_balances"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "inventory_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inventory_movements_isolation" ON "inventory_movements";
CREATE POLICY "inventory_movements_isolation" ON "inventory_movements"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customers_isolation" ON "customers";
CREATE POLICY "customers_isolation" ON "customers"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shifts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "shifts_isolation" ON "shifts";
CREATE POLICY "shifts_isolation" ON "shifts"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "cash_movements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cash_movements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cash_movements_isolation" ON "cash_movements";
CREATE POLICY "cash_movements_isolation" ON "cash_movements"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sales" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sales_isolation" ON "sales";
CREATE POLICY "sales_isolation" ON "sales"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "sale_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale_lines_isolation" ON "sale_lines";
CREATE POLICY "sale_lines_isolation" ON "sale_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "sale_discounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_discounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale_discounts_isolation" ON "sale_discounts";
CREATE POLICY "sale_discounts_isolation" ON "sale_discounts"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "tenders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenders_isolation" ON "tenders";
CREATE POLICY "tenders_isolation" ON "tenders"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoices_isolation" ON "invoices";
CREATE POLICY "invoices_isolation" ON "invoices"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "invoice_tax_breakdown" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_tax_breakdown" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "invoice_tax_breakdown_isolation" ON "invoice_tax_breakdown";
CREATE POLICY "invoice_tax_breakdown_isolation" ON "invoice_tax_breakdown"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "returns" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "returns_isolation" ON "returns";
CREATE POLICY "returns_isolation" ON "returns"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "return_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "return_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "return_lines_isolation" ON "return_lines";
CREATE POLICY "return_lines_isolation" ON "return_lines"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refunds" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "refunds_isolation" ON "refunds";
CREATE POLICY "refunds_isolation" ON "refunds"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_keys" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "idempotency_keys_isolation" ON "idempotency_keys";
CREATE POLICY "idempotency_keys_isolation" ON "idempotency_keys"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "audit_events_isolation" ON "audit_events";
CREATE POLICY "audit_events_isolation" ON "audit_events"
  USING ("tenantId" = current_tenant_id())
  WITH CHECK ("tenantId" = current_tenant_id());

-- ---------------------------------------------------------------------------
-- Deliberately outside RLS
-- ---------------------------------------------------------------------------
--
-- permissions          The application's own vocabulary. Identical for every
--                      tenant, derived from nobody's data. Tenants bind these
--                      keys to their own roles through role_permissions, which
--                      IS tenant-owned and IS protected.
--
-- global_catalog_items The national barcode catalogue: shared reference data,
--                      identical for every merchant, none of it private
--                      (ADR-0004).
--
-- Enabling RLS on either would require a policy permitting everything, which
-- is a misleading way to write "not protected".
SQLEOF

say "Domain — persistence ports"

cat << 'EOF' > packages/domain/src/ports/persistence.ts
import { DomainError } from '../errors.js';
import type { BasisPoints } from '../tax/basis-points.js';
// Reused, not redeclared. A second `PriceMode` that happened to agree today
// would be free to disagree tomorrow, and the two would sit on either side of
// the persistence boundary.
import type { PriceMode } from '../pricing/line.js';
import type { TenderKind } from '../tender/tender.js';

/**
 * Repository ports.
 *
 * The domain declares what it needs; packages/database supplies it. Prisma
 * types never cross this line, which is what keeps the core liftable into
 * Korvi ERP later (ADR-0001) and stops ORM shapes reaching the UI (ADR-0004).
 *
 * Two conventions hold throughout this file:
 *
 *   Money and quantity cross as decimal *strings* of the underlying integer —
 *   `"1500"` halalas, `"1250"` thousandths of a kilo. A bigint cannot be
 *   JSON-serialised and a number silently loses halalas above 2^53. See
 *   ADR-0002.
 *
 *   Timestamps cross as ISO 8601 strings. A Date is mutable and carries a
 *   local-timezone rendering that survives no boundary intact.
 */

/** Branded so a bare string cannot be passed where a tenant is expected. */
export type TenantId = string & { readonly __brand: 'TenantId' };

export function tenantId(value: string): TenantId {
  return value as TenantId;
}

/**
 * Every tenant-owned read and write carries this.
 *
 * A `TenantScope` is a *claim that has already been verified*. Nothing in this
 * package can verify it — that is the authentication layer's job, and it does
 * not exist yet. What this type does is make the absence visible: a repository
 * method cannot be called without one, so no future caller can reach the
 * database having merely read a tenant id off a request body.
 *
 * The repositories go further and establish PostgreSQL RLS context from the
 * scope, so a forged or mistaken id yields an empty result set rather than
 * another merchant's rows. That is the actual boundary; this type is the
 * reminder of where it sits.
 *
 * GlobalCatalog is deliberately outside it: the national barcode catalogue is
 * shared infrastructure, not tenant data, and giving it a tenantId would mean
 * storing hundreds of thousands of duplicate rows per merchant (ADR-0004).
 */
export interface TenantScope {
  readonly tenantId: TenantId;
}

/**
 * A row surfaced under one tenant's scope carried another tenant's id.
 *
 * If this is ever thrown, RLS has been bypassed or a query was written without
 * a tenant filter. It is deliberately fatal: returning the row would be a
 * cross-tenant data leak, and returning null would hide a broken boundary.
 */
export class CrossTenantAccessError extends DomainError {
  public override readonly name = 'CrossTenantAccessError';
}

/** Belt and braces over RLS. Every adapter mapper calls this. */
export function assertSameTenant(scope: TenantScope, rowTenantId: string): void {
  if (rowTenantId !== (scope.tenantId as string)) {
    throw new CrossTenantAccessError(
      'A row from another tenant reached a tenant-scoped read. Refusing to return it.',
    );
  }
}

// ---------------------------------------------------------------------------
// Tenancy and configuration
// ---------------------------------------------------------------------------

export type TenantStatus = 'active' | 'suspended' | 'closed';

/** The minimum needed to identify a tenant before any scope exists. */
export interface TenantIdentity {
  readonly id: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly status: TenantStatus;
}

export interface Tenant extends TenantIdentity {
  readonly vatNumber: string | null;
}

export type Vertical = 'retail' | 'grocery' | 'restaurant' | 'pharmacy';

export interface TenantSettings {
  readonly tenantId: TenantId;
  readonly vertical: Vertical;
  readonly priceMode: PriceMode;
  readonly defaultVatBasisPoints: BasisPoints;
  readonly currency: string;
  readonly requireBarcode: boolean;
  readonly allowWeightedItems: boolean;
  readonly trackInventory: boolean;
  readonly allowNegativeStock: boolean;
  readonly receiptHeaderAr: string | null;
  readonly receiptFooterAr: string | null;
}

export interface Branch {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
}

export interface Terminal {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly lastSeenAt: string | null;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

export type ProductType = 'unit' | 'weighted';

export interface Product {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly categoryId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: ProductType;
  readonly unitLabel: string;
  /** Minor units, as a string at this boundary. See ADR-0002. */
  readonly priceMinor: string;
  /**
   * Branded and validated, not a bare number. The adapter narrows the integer
   * column through `basisPointsFromColumn`, so a corrupt row fails at the
   * boundary instead of producing a wrong tax figure downstream.
   */
  readonly vatBasisPoints: BasisPoints;
  /**
   * A product may carry several barcodes — a case, a single, a re-label. The
   * primary one is what a receipt prints; the rest still scan.
   */
  readonly primaryBarcode: string | null;
  readonly barcodes: readonly string[];
  readonly trackInventory: boolean;
  readonly isActive: boolean;
}

export interface GlobalCatalogItem {
  readonly barcode: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly vatBasisPoints: BasisPoints;
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

export type InventoryMovementKind = 'sale' | 'return' | 'adjustment' | 'receipt' | 'transfer';

export interface InventoryBalance {
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly productId: string;
  /** Scaled by 1000, signed. A negative balance is an oversell. */
  readonly quantityScaled: string;
}

export interface InventoryMovementInput {
  readonly id: string;
  readonly branchId: string;
  readonly productId: string;
  readonly kind: InventoryMovementKind;
  /** Signed and scaled by 1000: a sale is negative, a receipt positive. */
  readonly quantityScaled: string;
  readonly reason: string | null;
  readonly sourceType: string | null;
  readonly sourceId: string | null;
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export interface Customer {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
  readonly isActive: boolean;
}

export interface CreateCustomerInput {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export type ShiftStatusRecord = 'open' | 'closed';

export type CashMovementKindRecord = 'sale' | 'refund' | 'pay-in' | 'pay-out' | 'opening-float';

export interface CashMovementRecord {
  readonly id: string;
  readonly shiftId: string;
  readonly kind: CashMovementKindRecord;
  /** Signed halalas: a pay-out and a refund are negative. */
  readonly amountMinor: string;
  readonly reason: string | null;
  readonly actorUserId: string | null;
  readonly occurredAt: string;
}

export interface ShiftRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly status: ShiftStatusRecord;
  readonly openingFloatMinor: string;
  readonly declaredCashMinor: string | null;
  readonly expectedCashMinor: string | null;
  readonly varianceMinor: string | null;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly movements: readonly CashMovementRecord[];
}

export interface OpenShiftInput {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly openingFloatMinor: string;
  readonly openedAt: string;
  /** The opening-float movement, so the drawer's history starts at zero gaps. */
  readonly openingMovementId: string;
}

export interface CloseShiftInput {
  readonly shiftId: string;
  readonly declaredCashMinor: string;
  readonly expectedCashMinor: string;
  readonly varianceMinor: string;
  readonly closedAt: string;
}

// ---------------------------------------------------------------------------
// Sales and invoices
// ---------------------------------------------------------------------------

export type SaleStatus = 'finalized' | 'voided';

/**
 * A sale line as stored.
 *
 * Every descriptive and financial field is a snapshot. Nothing here is read
 * back from `products`: a price change tomorrow must not alter what yesterday's
 * invoice says, and a deleted product must not make an old receipt
 * unprintable.
 */
export interface SaleLineRecord {
  readonly id: string;
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly unitPriceMinor: string;
  readonly vatBasisPoints: BasisPoints;
  readonly quantityScaled: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface SaleDiscountRecord {
  readonly id: string;
  readonly scope: 'line' | 'basket';
  readonly lineNumber: number | null;
  readonly kind: 'fixed' | 'percentage';
  readonly inputValue: string;
  readonly amountMinor: string;
  readonly reason: string | null;
  readonly grantedByUserId: string | null;
}

export interface TenderRecord {
  readonly id: string;
  readonly kind: TenderKind;
  readonly amountMinor: string;
  readonly changeMinor: string;
  readonly reference: string | null;
}

export interface SaleRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly userId: string;
  readonly customerId: string | null;
  readonly operationId: string;
  readonly status: SaleStatus;
  readonly sequence: number;
  readonly priceMode: PriceMode;
  readonly currency: string;
  readonly grossMinor: string;
  readonly lineDiscountMinor: string;
  readonly basketDiscountMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly tenderedMinor: string;
  readonly changeMinor: string;
  readonly issuedAt: string;
  readonly lines: readonly SaleLineRecord[];
  readonly discounts: readonly SaleDiscountRecord[];
  readonly tenders: readonly TenderRecord[];
}

export type InvoiceType = 'simplified' | 'standard';

export interface InvoiceTaxBucketRecord {
  readonly vatBasisPoints: BasisPoints;
  readonly netMinor: string;
  readonly vatMinor: string;
}

export interface InvoiceRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly saleId: string;
  readonly invoiceNumber: string;
  readonly invoiceType: InvoiceType;
  readonly sellerName: string;
  readonly sellerVatNumber: string;
  readonly buyerName: string | null;
  readonly buyerVatNumber: string | null;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly currency: string;
  readonly issuedAt: string;
  readonly taxBreakdown: readonly InvoiceTaxBucketRecord[];
}

/**
 * Everything one checkout writes, in one value.
 *
 * The sale, its invoice, the stock it consumed, the cash it put in the drawer
 * and the idempotency reservation are a single fact about the world. Writing
 * them in separate calls would allow a crash to leave an invoice with no sale,
 * or stock decremented for a sale that never existed — so the port takes them
 * together and the adapter commits them in one transaction.
 */
export interface RecordSaleInput {
  readonly sale: Omit<SaleRecord, 'tenantId'>;
  readonly invoice: Omit<InvoiceRecord, 'tenantId'>;
  readonly inventory: readonly InventoryMovementInput[];
  readonly cashMovement: CashMovementRecord | null;
  readonly idempotency: IdempotencyReservation;
}

// ---------------------------------------------------------------------------
// Idempotency and audit
// ---------------------------------------------------------------------------

export type IdempotencyStatus = 'reserved' | 'completed' | 'failed';

export interface IdempotencyReservation {
  readonly id: string;
  readonly scope: string;
  readonly operationId: string;
  /** Fingerprint of the request, so a replay with different content is seen. */
  readonly requestHash: string | null;
}

export interface IdempotencyRecord extends IdempotencyReservation {
  readonly tenantId: TenantId;
  readonly status: IdempotencyStatus;
  readonly resultType: string | null;
  readonly resultId: string | null;
  readonly completedAt: string | null;
}

export interface AuditEventInput {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly branchId: string | null;
  readonly terminalId: string | null;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /**
   * Structured context. Never a credential, token or password: audit rows are
   * the most widely read table in any support incident.
   */
  readonly metadata: Readonly<Record<string, string | number | boolean | null>> | null;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface TenantRepository {
  /** The tenant this scope names. Structurally incapable of returning another. */
  current(scope: TenantScope): Promise<Tenant | null>;
  settings(scope: TenantScope): Promise<TenantSettings | null>;
}

/*
 * There is deliberately no unscoped tenant lookup of any kind — no resolution
 * by hostname, by subdomain, or by any other public handle.
 *
 * Resolving a hostname to a tenant has to happen before a scope exists, which
 * makes it the one read that cannot be tenant-scoped — and `tenants` is under
 * RLS, so it cannot be served from this layer at all without a policy or a
 * role that weakens the boundary. That decision belongs with authentication,
 * which this strike does not build. Provisioning the first tenant is the same
 * shape of problem and has the same answer: it runs as the migration role, not
 * through a repository.
 *
 * Leaving the gap visible is the point. An unscoped `findBySlug` added here
 * "temporarily" would be the one method every later caller reaches for.
 */

export interface BranchRepository {
  findById(scope: TenantScope, id: string): Promise<Branch | null>;
  list(scope: TenantScope): Promise<readonly Branch[]>;
}

export interface TerminalRepository {
  findById(scope: TenantScope, id: string): Promise<Terminal | null>;
  findByCode(scope: TenantScope, code: string): Promise<Terminal | null>;
  listForBranch(scope: TenantScope, branchId: string): Promise<readonly Terminal[]>;
  markSeen(scope: TenantScope, id: string, at: string): Promise<void>;
}

export interface ProductRepository {
  findById(scope: TenantScope, id: string): Promise<Product | null>;
  findBySku(scope: TenantScope, sku: string): Promise<Product | null>;
  findByBarcode(scope: TenantScope, barcode: string): Promise<Product | null>;
  list(scope: TenantScope, limit: number): Promise<readonly Product[]>;
}

export interface InventoryRepository {
  balance(scope: TenantScope, branchId: string, productId: string): Promise<InventoryBalance | null>;
  listBalances(scope: TenantScope, branchId: string, limit: number): Promise<readonly InventoryBalance[]>;
  /** Records the movement and moves the balance in one transaction. */
  applyMovement(scope: TenantScope, movement: InventoryMovementInput): Promise<InventoryBalance>;
}

export interface CustomerRepository {
  findById(scope: TenantScope, id: string): Promise<Customer | null>;
  findByPhone(scope: TenantScope, phone: string): Promise<Customer | null>;
  list(scope: TenantScope, limit: number): Promise<readonly Customer[]>;
  create(scope: TenantScope, input: CreateCustomerInput): Promise<Customer>;
}

export interface ShiftRepository {
  findById(scope: TenantScope, id: string): Promise<ShiftRecord | null>;
  findOpenForTerminal(scope: TenantScope, terminalId: string): Promise<ShiftRecord | null>;
  open(scope: TenantScope, input: OpenShiftInput): Promise<ShiftRecord>;
  recordCashMovement(scope: TenantScope, movement: CashMovementRecord): Promise<void>;
  close(scope: TenantScope, input: CloseShiftInput): Promise<ShiftRecord>;
}

export interface SaleRepository {
  findById(scope: TenantScope, id: string): Promise<SaleRecord | null>;
  /** The idempotent read: a retry finds the sale its first attempt created. */
  findByOperationId(scope: TenantScope, operationId: string): Promise<SaleRecord | null>;
  invoiceForSale(scope: TenantScope, saleId: string): Promise<InvoiceRecord | null>;
  /** Sale, lines, tenders, invoice, stock and cash — one transaction. */
  record(scope: TenantScope, input: RecordSaleInput): Promise<SaleRecord>;
}

export interface IdempotencyRepository {
  find(scope: TenantScope, scopeKey: string, operationId: string): Promise<IdempotencyRecord | null>;
  reserve(scope: TenantScope, reservation: IdempotencyReservation): Promise<IdempotencyRecord>;
  complete(
    scope: TenantScope,
    scopeKey: string,
    operationId: string,
    result: { readonly resultType: string; readonly resultId: string; readonly at: string },
  ): Promise<void>;
}

export interface AuditRepository {
  append(scope: TenantScope, event: AuditEventInput): Promise<void>;
  list(scope: TenantScope, limit: number): Promise<readonly AuditEventInput[]>;
}

export interface GlobalCatalogRepository {
  findByBarcode(barcode: string): Promise<GlobalCatalogItem | null>;
}
EOF

say "Repositories — mapping boundary"

cat << 'EOF' > packages/database/src/repositories/mapping.ts
import { assertSameTenant, basisPointsFromColumn, tenantId } from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import type { BasisPoints, TenantId, TenantScope } from '@korvi/domain';

/**
 * The mapping boundary.
 *
 * Every repository row passes through these helpers on its way out. Three
 * things happen here and nowhere else:
 *
 *   BigInt becomes a string. Prisma hands back a native bigint; JSON.stringify
 *   throws on one, and Number() loses halalas above 2^53 (ADR-0002).
 *
 *   Date becomes ISO 8601. A Date carries a local rendering that survives no
 *   boundary intact.
 *
 *   Free-text status columns are narrowed to their union. A row whose `status`
 *   says something the code has never heard of fails here, loudly, instead of
 *   flowing into a switch that silently takes the default branch.
 *
 * The tenant check is the fourth: `scoped()` refuses a row whose tenantId is
 * not the scope's. Under RLS that row cannot exist, so the assertion is a
 * tripwire on the boundary rather than the boundary itself.
 */

export function minor(value: bigint): string {
  return value.toString();
}

export function minorOrNull(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

export function iso(value: Date): string {
  return value.toISOString();
}

export function isoOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function rate(column: number): BasisPoints {
  return basisPointsFromColumn(column);
}

/** Narrow a row's tenantId, having first proved it belongs to the scope. */
export function scoped(scope: TenantScope, rowTenantId: string): TenantId {
  assertSameTenant(scope, rowTenantId);
  return tenantId(rowTenantId);
}

/** The scope's tenant id as the plain string a query parameter needs. */
export function tenantParam(scope: TenantScope): string {
  return scope.tenantId as string;
}

/**
 * Narrow a text column to a known union.
 *
 * Throws rather than defaulting: a `priceMode` of "tax-inclusiv" that quietly
 * became "tax-exclusive" would misprice every line on the receipt.
 */
export function oneOf<T extends string>(allowed: readonly T[], value: string, column: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new DatabaseError(
      `Column ${column} holds "${value}", which is not one of: ${allowed.join(', ')}.`,
    );
  }
  return match;
}
EOF

say "Repositories — tenancy, branches, terminals"

cat << 'EOF' > packages/database/src/repositories/tenant-repository.ts
import { withTenant } from '../tenant-context.js';
import { oneOf, rate, scoped, tenantParam } from './mapping.js';
import type {
  PriceMode,
  Tenant,
  TenantRepository,
  TenantScope,
  TenantSettings,
  TenantStatus,
  Vertical,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly TenantStatus[] = ['active', 'suspended', 'closed'];
const VERTICALS: readonly Vertical[] = ['retail', 'grocery', 'restaurant', 'pharmacy'];
const PRICE_MODES: readonly PriceMode[] = ['tax-inclusive', 'tax-exclusive'];

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  vatNumber: string | null;
  status: string;
}

interface SettingsRow {
  tenantId: string;
  vertical: string;
  priceMode: string;
  defaultVatBasisPoints: number;
  currency: string;
  requireBarcode: boolean;
  allowWeightedItems: boolean;
  trackInventory: boolean;
  allowNegativeStock: boolean;
  receiptHeaderAr: string | null;
  receiptFooterAr: string | null;
}

/**
 * Reads about the tenant itself.
 *
 * `current()` takes a scope and can only ever return the tenant that scope
 * names — there is no findById, because a method that takes an arbitrary
 * tenant id and returns that tenant is exactly the cross-tenant read this
 * layer exists to prevent.
 */
export function createTenantRepository(prisma: PrismaClient): TenantRepository {
  return {
    async current(scope: TenantScope): Promise<Tenant | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: TenantRow | null = await tx.tenant.findFirst({
          where: { id: tenantParam(scope) },
        });
        if (row === null) return null;
        return {
          id: scoped(scope, row.id),
          slug: row.slug,
          name: row.name,
          status: oneOf(STATUSES, row.status, 'tenants.status'),
          vatNumber: row.vatNumber,
        };
      });
    },

    async settings(scope: TenantScope): Promise<TenantSettings | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: SettingsRow | null = await tx.tenantSettings.findFirst({
          where: { tenantId: tenantParam(scope) },
        });
        if (row === null) return null;
        return {
          tenantId: scoped(scope, row.tenantId),
          vertical: oneOf(VERTICALS, row.vertical, 'tenant_settings.vertical'),
          priceMode: oneOf(PRICE_MODES, row.priceMode, 'tenant_settings.priceMode'),
          defaultVatBasisPoints: rate(row.defaultVatBasisPoints),
          currency: row.currency,
          requireBarcode: row.requireBarcode,
          allowWeightedItems: row.allowWeightedItems,
          trackInventory: row.trackInventory,
          allowNegativeStock: row.allowNegativeStock,
          receiptHeaderAr: row.receiptHeaderAr,
          receiptFooterAr: row.receiptFooterAr,
        };
      });
    },
  };
}

/*
 * No `findBySlug`, and no unscoped tenant lookup of any kind — see the note in
 * @korvi/domain's ports/persistence.ts. Hostname-to-tenant resolution runs
 * before a scope exists and therefore belongs with authentication, which this
 * strike does not build. A "temporary" unscoped lookup added here would become
 * the method every later caller reaches for.
 */
EOF

cat << 'EOF' > packages/database/src/repositories/branch-repository.ts
import { withTenant } from '../tenant-context.js';
import { scoped, tenantParam } from './mapping.js';
import type { Branch, BranchRepository, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface BranchRow {
  id: string;
  tenantId: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  isActive: boolean;
}

function toDomain(scope: TenantScope, row: BranchRow): Branch {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    code: row.code,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    isActive: row.isActive,
  };
}

export function createBranchRepository(prisma: PrismaClient): BranchRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Branch | null> {
      // Both halves matter. `tenantId` in the filter is the application saying
      // what it means; RLS is Postgres enforcing it even when a future edit
      // forgets. Neither alone is a boundary.
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: BranchRow | null = await tx.branch.findFirst({
          where: { id, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async list(scope: TenantScope): Promise<readonly Branch[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: BranchRow[] = await tx.branch.findMany({
          where: { tenantId: tenantParam(scope) },
          orderBy: { code: 'asc' },
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },
  };
}
EOF

cat << 'EOF' > packages/database/src/repositories/terminal-repository.ts
import { withTenant } from '../tenant-context.js';
import { isoOrNull, scoped, tenantParam } from './mapping.js';
import type { TenantScope, Terminal, TerminalRepository } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface TerminalRow {
  id: string;
  tenantId: string;
  branchId: string;
  code: string;
  label: string;
  isActive: boolean;
  lastSeenAt: Date | null;
}

function toDomain(scope: TenantScope, row: TerminalRow): Terminal {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    code: row.code,
    label: row.label,
    isActive: row.isActive,
    lastSeenAt: isoOrNull(row.lastSeenAt),
  };
}

export function createTerminalRepository(prisma: PrismaClient): TerminalRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Terminal | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: TerminalRow | null = await tx.terminal.findFirst({
          where: { id, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findByCode(scope: TenantScope, code: string): Promise<Terminal | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: TerminalRow | null = await tx.terminal.findFirst({
          where: { code, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async listForBranch(scope: TenantScope, branchId: string): Promise<readonly Terminal[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: TerminalRow[] = await tx.terminal.findMany({
          where: { branchId, tenantId: tenantParam(scope) },
          orderBy: { code: 'asc' },
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },

    async markSeen(scope: TenantScope, id: string, at: string): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        // updateMany, not update: `update` targets a primary key alone, which
        // would let a terminal id from another tenant be written to. The
        // tenant filter is only expressible on a many-update.
        await tx.terminal.updateMany({
          where: { id, tenantId: tenantParam(scope) },
          data: { lastSeenAt: new Date(at) },
        });
      });
    },
  };
}
EOF

say "Repositories — catalogue and inventory"

cat << 'EOF' > packages/database/src/repositories/product-repository.ts
import { withTenant, withoutTenant } from '../tenant-context.js';
import { oneOf, rate, scoped, tenantParam } from './mapping.js';
import type {
  GlobalCatalogItem,
  GlobalCatalogRepository,
  Product,
  ProductRepository,
  ProductType,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * Prisma-backed adapter for the domain's ProductRepository port.
 *
 * Every method maps the ORM row to the domain shape before returning. That
 * mapping is the boundary: no Prisma type escapes this file, so the UI and the
 * domain never learn what the ORM is (ADR-0001, ADR-0004).
 *
 * `priceMinor` crosses as a string. Prisma hands back a BigInt, and letting a
 * BigInt reach a JSON boundary either throws or silently degrades to a float.
 *
 * `vatBasisPoints` is narrowed through `basisPointsFromColumn`, which validates
 * the range. A corrupt row then fails at this boundary rather than producing a
 * wrong tax figure on a printed invoice.
 */

const PRODUCT_TYPES: readonly ProductType[] = ['unit', 'weighted'];

interface BarcodeRow {
  barcode: string;
  isPrimary: boolean;
}

interface ProductRow {
  id: string;
  tenantId: string;
  categoryId: string | null;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  productType: string;
  unitLabel: string;
  priceMinor: bigint;
  vatBasisPoints: number;
  trackInventory: boolean;
  isActive: boolean;
  barcodes: BarcodeRow[];
}

function toDomain(scope: TenantScope, row: ProductRow): Product {
  const primary = row.barcodes.find((candidate) => candidate.isPrimary) ?? row.barcodes.at(0);
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    categoryId: row.categoryId,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    productType: oneOf(PRODUCT_TYPES, row.productType, 'products.productType'),
    unitLabel: row.unitLabel,
    priceMinor: row.priceMinor.toString(),
    vatBasisPoints: rate(row.vatBasisPoints),
    primaryBarcode: primary === undefined ? null : primary.barcode,
    barcodes: row.barcodes.map((candidate) => candidate.barcode),
    trackInventory: row.trackInventory,
    isActive: row.isActive,
  };
}

const WITH_BARCODES = {
  barcodes: { select: { barcode: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
} as const;

export function createProductRepository(prisma: PrismaClient): ProductRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Product | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.product.findFirst({
          where: { id, tenantId: tenantParam(scope) },
          include: WITH_BARCODES,
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findBySku(scope: TenantScope, sku: string): Promise<Product | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.product.findFirst({
          where: { sku, tenantId: tenantParam(scope) },
          include: WITH_BARCODES,
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findByBarcode(scope: TenantScope, barcode: string): Promise<Product | null> {
      // The barcode is unique *within* a tenant, not globally: two merchants
      // may legitimately stock the same EAN. Scoping the lookup is therefore
      // correctness as well as isolation.
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.product.findFirst({
          where: {
            tenantId: tenantParam(scope),
            barcodes: { some: { barcode, tenantId: tenantParam(scope) } },
          },
          include: WITH_BARCODES,
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async list(scope: TenantScope, limit: number): Promise<readonly Product[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows = await tx.product.findMany({
          where: { tenantId: tenantParam(scope) },
          orderBy: { sku: 'asc' },
          take: limit,
          include: WITH_BARCODES,
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },
  };
}

/**
 * The national catalogue: shared reference data, no tenant, no RLS.
 *
 * Read-only here on purpose. A merchant scanning an unknown barcode gets a
 * name suggestion from it; nothing in the sale path writes to it, so one
 * tenant's mistake cannot become every tenant's product name.
 */
export function createGlobalCatalogRepository(prisma: PrismaClient): GlobalCatalogRepository {
  return {
    async findByBarcode(barcode: string): Promise<GlobalCatalogItem | null> {
      return withoutTenant(prisma, async (tx) => {
        const row = await tx.globalCatalogItem.findUnique({ where: { barcode } });
        if (row === null) return null;
        return {
          barcode: row.barcode,
          nameAr: row.nameAr,
          nameEn: row.nameEn,
          vatBasisPoints: rate(row.vatBasisPoints),
        };
      });
    },
  };
}
EOF

cat << 'EOF' > packages/database/src/repositories/inventory-repository.ts
import { withTenant } from '../tenant-context.js';
import { minor, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type {
  InventoryBalance,
  InventoryMovementInput,
  InventoryRepository,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface BalanceRow {
  tenantId: string;
  branchId: string;
  productId: string;
  quantityScaled: bigint;
}

function toDomain(scope: TenantScope, row: BalanceRow): InventoryBalance {
  return {
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    productId: row.productId,
    quantityScaled: minor(row.quantityScaled),
  };
}

/**
 * Apply one stock movement inside an existing transaction.
 *
 * Exported because a checkout must record its stock movements in the same
 * transaction as the sale: stock decremented for a sale that then failed to
 * commit is how a shelf count stops matching the shop floor.
 *
 * The balance moves by `increment`, not by read-modify-write. Two terminals
 * selling the last unit of the same product at the same moment would both read
 * 1 and both write 0; `increment` makes the arithmetic happen in the database,
 * under its row lock, so the second sees 0 and can be refused.
 */
export async function applyMovementWithin(
  tx: TransactionClient,
  tenant: string,
  movement: InventoryMovementInput,
): Promise<BalanceRow> {
  const quantity = BigInt(movement.quantityScaled);

  await tx.inventoryMovement.create({
    data: {
      id: movement.id,
      tenantId: tenant,
      branchId: movement.branchId,
      productId: movement.productId,
      kind: movement.kind,
      quantityScaled: quantity,
      reason: movement.reason,
      sourceType: movement.sourceType,
      sourceId: movement.sourceId,
      actorUserId: movement.actorUserId,
      occurredAt: new Date(movement.occurredAt),
    },
  });

  return tx.inventoryBalance.upsert({
    where: {
      tenantId_branchId_productId: {
        tenantId: tenant,
        branchId: movement.branchId,
        productId: movement.productId,
      },
    },
    create: {
      tenantId: tenant,
      branchId: movement.branchId,
      productId: movement.productId,
      quantityScaled: quantity,
    },
    update: { quantityScaled: { increment: quantity } },
  });
}

export function createInventoryRepository(prisma: PrismaClient): InventoryRepository {
  return {
    async balance(
      scope: TenantScope,
      branchId: string,
      productId: string,
    ): Promise<InventoryBalance | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: BalanceRow | null = await tx.inventoryBalance.findFirst({
          where: { branchId, productId, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async listBalances(
      scope: TenantScope,
      branchId: string,
      limit: number,
    ): Promise<readonly InventoryBalance[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: BalanceRow[] = await tx.inventoryBalance.findMany({
          where: { branchId, tenantId: tenantParam(scope) },
          orderBy: { productId: 'asc' },
          take: limit,
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },

    async applyMovement(
      scope: TenantScope,
      movement: InventoryMovementInput,
    ): Promise<InventoryBalance> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await applyMovementWithin(tx, tenantParam(scope), movement);
        return toDomain(scope, row);
      });
    },
  };
}
EOF

cat << 'EOF' > packages/database/src/repositories/customer-repository.ts
import { withTenant } from '../tenant-context.js';
import { scoped, tenantParam } from './mapping.js';
import type {
  CreateCustomerInput,
  Customer,
  CustomerRepository,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface CustomerRow {
  id: string;
  tenantId: string;
  nameAr: string;
  nameEn: string | null;
  phone: string | null;
  email: string | null;
  vatNumber: string | null;
  isActive: boolean;
}

function toDomain(scope: TenantScope, row: CustomerRow): Customer {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    phone: row.phone,
    email: row.email,
    vatNumber: row.vatNumber,
    isActive: row.isActive,
  };
}

export function createCustomerRepository(prisma: PrismaClient): CustomerRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<Customer | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: CustomerRow | null = await tx.customer.findFirst({
          where: { id, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findByPhone(scope: TenantScope, phone: string): Promise<Customer | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: CustomerRow | null = await tx.customer.findFirst({
          where: { phone, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async list(scope: TenantScope, limit: number): Promise<readonly Customer[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: CustomerRow[] = await tx.customer.findMany({
          where: { tenantId: tenantParam(scope) },
          orderBy: { nameAr: 'asc' },
          take: limit,
        });
        return rows.map((row) => toDomain(scope, row));
      });
    },

    async create(scope: TenantScope, input: CreateCustomerInput): Promise<Customer> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        // tenantId comes from the scope, never from the input. A create that
        // accepted a tenant id in its payload would be a way to write a row
        // into somebody else's shop.
        const row: CustomerRow = await tx.customer.create({
          data: {
            id: input.id,
            tenantId: tenantParam(scope),
            nameAr: input.nameAr,
            nameEn: input.nameEn,
            phone: input.phone,
            email: input.email,
            vatNumber: input.vatNumber,
          },
        });
        return toDomain(scope, row);
      });
    },
  };
}
EOF

say "Repositories — shifts"

cat << 'EOF' > packages/database/src/repositories/shift-repository.ts
import { withTenant } from '../tenant-context.js';
import { DatabaseError } from '../errors.js';
import { iso, isoOrNull, minor, minorOrNull, oneOf, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type {
  CashMovementKindRecord,
  CashMovementRecord,
  CloseShiftInput,
  OpenShiftInput,
  ShiftRecord,
  ShiftRepository,
  ShiftStatusRecord,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly ShiftStatusRecord[] = ['open', 'closed'];
const KINDS: readonly CashMovementKindRecord[] = [
  'sale',
  'refund',
  'pay-in',
  'pay-out',
  'opening-float',
];

interface MovementRow {
  id: string;
  shiftId: string;
  kind: string;
  amountMinor: bigint;
  reason: string | null;
  actorUserId: string | null;
  occurredAt: Date;
}

interface ShiftRow {
  id: string;
  tenantId: string;
  branchId: string;
  terminalId: string;
  userId: string;
  status: string;
  openingFloatMinor: bigint;
  declaredCashMinor: bigint | null;
  expectedCashMinor: bigint | null;
  varianceMinor: bigint | null;
  openedAt: Date;
  closedAt: Date | null;
  cashMovements: MovementRow[];
}

function movementToDomain(row: MovementRow): CashMovementRecord {
  return {
    id: row.id,
    shiftId: row.shiftId,
    kind: oneOf(KINDS, row.kind, 'cash_movements.kind'),
    amountMinor: minor(row.amountMinor),
    reason: row.reason,
    actorUserId: row.actorUserId,
    occurredAt: iso(row.occurredAt),
  };
}

function toDomain(scope: TenantScope, row: ShiftRow): ShiftRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    terminalId: row.terminalId,
    userId: row.userId,
    status: oneOf(STATUSES, row.status, 'shifts.status'),
    openingFloatMinor: minor(row.openingFloatMinor),
    declaredCashMinor: minorOrNull(row.declaredCashMinor),
    expectedCashMinor: minorOrNull(row.expectedCashMinor),
    varianceMinor: minorOrNull(row.varianceMinor),
    openedAt: iso(row.openedAt),
    closedAt: isoOrNull(row.closedAt),
    movements: row.cashMovements.map(movementToDomain),
  };
}

const WITH_MOVEMENTS = {
  cashMovements: { orderBy: { occurredAt: 'asc' } },
} as const;

async function loadShift(
  tx: TransactionClient,
  tenant: string,
  id: string,
): Promise<ShiftRow | null> {
  return tx.shift.findFirst({ where: { id, tenantId: tenant }, include: WITH_MOVEMENTS });
}

export function createShiftRepository(prisma: PrismaClient): ShiftRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<ShiftRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadShift(tx, tenantParam(scope), id);
        return row === null ? null : toDomain(scope, row);
      });
    },

    async findOpenForTerminal(
      scope: TenantScope,
      terminalId: string,
    ): Promise<ShiftRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.shift.findFirst({
          where: { terminalId, status: 'open', tenantId: tenantParam(scope) },
          orderBy: { openedAt: 'desc' },
          include: WITH_MOVEMENTS,
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async open(scope: TenantScope, input: OpenShiftInput): Promise<ShiftRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);

        // A till with two open shifts has no answerable cash position, so the
        // second open is refused rather than allowed to produce one.
        const existing = await tx.shift.findFirst({
          where: { terminalId: input.terminalId, status: 'open', tenantId: tenant },
        });
        if (existing !== null) {
          throw new DatabaseError(
            `Terminal ${input.terminalId} already has an open shift (${existing.id}).`,
          );
        }

        await tx.shift.create({
          data: {
            id: input.id,
            tenantId: tenant,
            branchId: input.branchId,
            terminalId: input.terminalId,
            userId: input.userId,
            status: 'open',
            openingFloatMinor: BigInt(input.openingFloatMinor),
            openedAt: new Date(input.openedAt),
          },
        });

        // The opening float is recorded as a movement of zero, matching the
        // domain: the float is the starting balance, not money that arrived.
        await tx.cashMovement.create({
          data: {
            id: input.openingMovementId,
            tenantId: tenant,
            shiftId: input.id,
            kind: 'opening-float',
            amountMinor: 0n,
            reason: null,
            actorUserId: input.userId,
            occurredAt: new Date(input.openedAt),
          },
        });

        const row = await loadShift(tx, tenant, input.id);
        if (row === null) {
          throw new DatabaseError('The shift just written could not be read back.');
        }
        return toDomain(scope, row);
      });
    },

    async recordCashMovement(scope: TenantScope, movement: CashMovementRecord): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const shift = await tx.shift.findFirst({
          where: { id: movement.shiftId, tenantId: tenant },
        });
        if (shift === null) {
          throw new DatabaseError(`No shift ${movement.shiftId} in this tenant.`);
        }
        if (shift.status !== 'open') {
          throw new DatabaseError('Cannot record a cash movement against a closed shift.');
        }
        await tx.cashMovement.create({
          data: {
            id: movement.id,
            tenantId: tenant,
            shiftId: movement.shiftId,
            kind: movement.kind,
            amountMinor: BigInt(movement.amountMinor),
            reason: movement.reason,
            actorUserId: movement.actorUserId,
            occurredAt: new Date(movement.occurredAt),
          },
        });
      });
    },

    async close(scope: TenantScope, input: CloseShiftInput): Promise<ShiftRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);

        // updateMany with status in the filter, so closing a shift twice
        // affects zero rows instead of overwriting the first declaration.
        const changed = await tx.shift.updateMany({
          where: { id: input.shiftId, tenantId: tenant, status: 'open' },
          data: {
            status: 'closed',
            declaredCashMinor: BigInt(input.declaredCashMinor),
            expectedCashMinor: BigInt(input.expectedCashMinor),
            varianceMinor: BigInt(input.varianceMinor),
            closedAt: new Date(input.closedAt),
          },
        });
        if (changed.count !== 1) {
          throw new DatabaseError(
            `Shift ${input.shiftId} is not open in this tenant; nothing was closed.`,
          );
        }

        const row = await loadShift(tx, tenant, input.shiftId);
        if (row === null) {
          throw new DatabaseError('The shift just closed could not be read back.');
        }
        return toDomain(scope, row);
      });
    },
  };
}
EOF

say "Repositories — sales, invoices, idempotency, audit"

cat << 'EOF' > packages/database/src/repositories/sale-repository.ts
import { withTenant } from '../tenant-context.js';
import { DatabaseError } from '../errors.js';
import { applyMovementWithin } from './inventory-repository.js';
import { iso, minor, oneOf, rate, scoped, tenantParam } from './mapping.js';
import type { TransactionClient } from '../tenant-context.js';
import type {
  InvoiceRecord,
  InvoiceType,
  PriceMode,
  RecordSaleInput,
  SaleDiscountRecord,
  SaleLineRecord,
  SaleRecord,
  SaleRepository,
  SaleStatus,
  TenantScope,
  TenderKind,
  TenderRecord,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly SaleStatus[] = ['finalized', 'voided'];
const PRICE_MODES: readonly PriceMode[] = ['tax-inclusive', 'tax-exclusive'];
const TENDER_KINDS: readonly TenderKind[] = ['cash', 'card', 'mada', 'transfer'];
const INVOICE_TYPES: readonly InvoiceType[] = ['simplified', 'standard'];
const DISCOUNT_SCOPES = ['line', 'basket'] as const;
const DISCOUNT_KINDS = ['fixed', 'percentage'] as const;

interface LineRow {
  id: string;
  lineNumber: number;
  productId: string | null;
  sku: string;
  nameAr: string;
  nameEn: string | null;
  unitPriceMinor: bigint;
  vatBasisPoints: number;
  quantityScaled: bigint;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
}

interface DiscountRow {
  id: string;
  scope: string;
  lineNumber: number | null;
  kind: string;
  inputValue: bigint;
  amountMinor: bigint;
  reason: string | null;
  grantedByUserId: string | null;
}

interface TenderRow {
  id: string;
  kind: string;
  amountMinor: bigint;
  changeMinor: bigint;
  reference: string | null;
}

interface SaleRow {
  id: string;
  tenantId: string;
  branchId: string;
  terminalId: string;
  shiftId: string;
  userId: string;
  customerId: string | null;
  operationId: string;
  status: string;
  sequence: number;
  priceMode: string;
  currency: string;
  grossMinor: bigint;
  lineDiscountMinor: bigint;
  basketDiscountMinor: bigint;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  tenderedMinor: bigint;
  changeMinor: bigint;
  issuedAt: Date;
  lines: LineRow[];
  discounts: DiscountRow[];
  tenders: TenderRow[];
}

interface BucketRow {
  vatBasisPoints: number;
  netMinor: bigint;
  vatMinor: bigint;
}

interface InvoiceRow {
  id: string;
  tenantId: string;
  saleId: string;
  invoiceNumber: string;
  invoiceType: string;
  sellerName: string;
  sellerVatNumber: string;
  buyerName: string | null;
  buyerVatNumber: string | null;
  netMinor: bigint;
  vatMinor: bigint;
  totalMinor: bigint;
  currency: string;
  issuedAt: Date;
  taxBreakdown: BucketRow[];
}

function lineToDomain(row: LineRow): SaleLineRecord {
  return {
    id: row.id,
    lineNumber: row.lineNumber,
    productId: row.productId,
    sku: row.sku,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    unitPriceMinor: minor(row.unitPriceMinor),
    vatBasisPoints: rate(row.vatBasisPoints),
    quantityScaled: minor(row.quantityScaled),
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
  };
}

function discountToDomain(row: DiscountRow): SaleDiscountRecord {
  return {
    id: row.id,
    scope: oneOf(DISCOUNT_SCOPES, row.scope, 'sale_discounts.scope'),
    lineNumber: row.lineNumber,
    kind: oneOf(DISCOUNT_KINDS, row.kind, 'sale_discounts.kind'),
    inputValue: minor(row.inputValue),
    amountMinor: minor(row.amountMinor),
    reason: row.reason,
    grantedByUserId: row.grantedByUserId,
  };
}

function tenderToDomain(row: TenderRow): TenderRecord {
  return {
    id: row.id,
    kind: oneOf(TENDER_KINDS, row.kind, 'tenders.kind'),
    amountMinor: minor(row.amountMinor),
    changeMinor: minor(row.changeMinor),
    reference: row.reference,
  };
}

function saleToDomain(scope: TenantScope, row: SaleRow): SaleRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    branchId: row.branchId,
    terminalId: row.terminalId,
    shiftId: row.shiftId,
    userId: row.userId,
    customerId: row.customerId,
    operationId: row.operationId,
    status: oneOf(STATUSES, row.status, 'sales.status'),
    sequence: row.sequence,
    priceMode: oneOf(PRICE_MODES, row.priceMode, 'sales.priceMode'),
    currency: row.currency,
    grossMinor: minor(row.grossMinor),
    lineDiscountMinor: minor(row.lineDiscountMinor),
    basketDiscountMinor: minor(row.basketDiscountMinor),
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
    tenderedMinor: minor(row.tenderedMinor),
    changeMinor: minor(row.changeMinor),
    issuedAt: iso(row.issuedAt),
    lines: row.lines.map(lineToDomain),
    discounts: row.discounts.map(discountToDomain),
    tenders: row.tenders.map(tenderToDomain),
  };
}

function invoiceToDomain(scope: TenantScope, row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    saleId: row.saleId,
    invoiceNumber: row.invoiceNumber,
    invoiceType: oneOf(INVOICE_TYPES, row.invoiceType, 'invoices.invoiceType'),
    sellerName: row.sellerName,
    sellerVatNumber: row.sellerVatNumber,
    buyerName: row.buyerName,
    buyerVatNumber: row.buyerVatNumber,
    netMinor: minor(row.netMinor),
    vatMinor: minor(row.vatMinor),
    totalMinor: minor(row.totalMinor),
    currency: row.currency,
    issuedAt: iso(row.issuedAt),
    taxBreakdown: row.taxBreakdown.map((bucket) => ({
      vatBasisPoints: rate(bucket.vatBasisPoints),
      netMinor: minor(bucket.netMinor),
      vatMinor: minor(bucket.vatMinor),
    })),
  };
}

const WITH_CHILDREN = {
  lines: { orderBy: { lineNumber: 'asc' } },
  discounts: true,
  tenders: true,
} as const;

async function loadSale(
  tx: TransactionClient,
  tenant: string,
  where: { id: string } | { operationId: string },
): Promise<SaleRow | null> {
  return tx.sale.findFirst({ where: { ...where, tenantId: tenant }, include: WITH_CHILDREN });
}

/**
 * The sale write path.
 *
 * `record` takes the whole checkout as one value and commits it in one
 * transaction: the sale, its lines and tenders, the tax document, the stock it
 * consumed, the cash it put in the drawer, and the idempotency reservation.
 * Splitting those across calls would let a crash leave an invoice with no
 * sale, or stock decremented for a sale that never existed.
 *
 * Replay safety comes from the database, not from a check-then-write. The
 * unique index on (tenantId, scope, operationId) means a second attempt at the
 * same checkout fails at insert rather than ringing up a second sale, and the
 * caller answers the retry from `findByOperationId`. A pre-flight "does it
 * exist?" query would still race between the read and the write.
 */
export function createSaleRepository(prisma: PrismaClient): SaleRepository {
  return {
    async findById(scope: TenantScope, id: string): Promise<SaleRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadSale(tx, tenantParam(scope), { id });
        return row === null ? null : saleToDomain(scope, row);
      });
    },

    async findByOperationId(scope: TenantScope, operationId: string): Promise<SaleRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await loadSale(tx, tenantParam(scope), { operationId });
        return row === null ? null : saleToDomain(scope, row);
      });
    },

    async invoiceForSale(scope: TenantScope, saleId: string): Promise<InvoiceRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row = await tx.invoice.findFirst({
          where: { saleId, tenantId: tenantParam(scope) },
          include: { taxBreakdown: { orderBy: { vatBasisPoints: 'asc' } } },
        });
        return row === null ? null : invoiceToDomain(scope, row);
      });
    },

    async record(scope: TenantScope, input: RecordSaleInput): Promise<SaleRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const tenant = tenantParam(scope);
        const { sale, invoice, inventory, cashMovement, idempotency } = input;

        await tx.idempotencyKey.create({
          data: {
            id: idempotency.id,
            tenantId: tenant,
            scope: idempotency.scope,
            operationId: idempotency.operationId,
            status: 'completed',
            resultType: 'sale',
            resultId: sale.id,
            requestHash: idempotency.requestHash,
            completedAt: new Date(sale.issuedAt),
          },
        });

        await tx.sale.create({
          data: {
            id: sale.id,
            tenantId: tenant,
            branchId: sale.branchId,
            terminalId: sale.terminalId,
            shiftId: sale.shiftId,
            userId: sale.userId,
            customerId: sale.customerId,
            operationId: sale.operationId,
            status: sale.status,
            sequence: sale.sequence,
            priceMode: sale.priceMode,
            currency: sale.currency,
            grossMinor: BigInt(sale.grossMinor),
            lineDiscountMinor: BigInt(sale.lineDiscountMinor),
            basketDiscountMinor: BigInt(sale.basketDiscountMinor),
            netMinor: BigInt(sale.netMinor),
            vatMinor: BigInt(sale.vatMinor),
            totalMinor: BigInt(sale.totalMinor),
            tenderedMinor: BigInt(sale.tenderedMinor),
            changeMinor: BigInt(sale.changeMinor),
            issuedAt: new Date(sale.issuedAt),
          },
        });

        await tx.saleLine.createMany({
          data: sale.lines.map((line) => ({
            id: line.id,
            tenantId: tenant,
            saleId: sale.id,
            productId: line.productId,
            lineNumber: line.lineNumber,
            sku: line.sku,
            nameAr: line.nameAr,
            nameEn: line.nameEn,
            unitPriceMinor: BigInt(line.unitPriceMinor),
            vatBasisPoints: Number(line.vatBasisPoints),
            quantityScaled: BigInt(line.quantityScaled),
            grossMinor: BigInt(line.grossMinor),
            lineDiscountMinor: BigInt(line.lineDiscountMinor),
            basketDiscountMinor: BigInt(line.basketDiscountMinor),
            netMinor: BigInt(line.netMinor),
            vatMinor: BigInt(line.vatMinor),
            totalMinor: BigInt(line.totalMinor),
          })),
        });

        if (sale.discounts.length > 0) {
          await tx.saleDiscount.createMany({
            data: sale.discounts.map((discount) => ({
              id: discount.id,
              tenantId: tenant,
              saleId: sale.id,
              scope: discount.scope,
              lineNumber: discount.lineNumber,
              kind: discount.kind,
              inputValue: BigInt(discount.inputValue),
              amountMinor: BigInt(discount.amountMinor),
              reason: discount.reason,
              grantedByUserId: discount.grantedByUserId,
            })),
          });
        }

        await tx.tender.createMany({
          data: sale.tenders.map((tender) => ({
            id: tender.id,
            tenantId: tenant,
            saleId: sale.id,
            kind: tender.kind,
            amountMinor: BigInt(tender.amountMinor),
            changeMinor: BigInt(tender.changeMinor),
            reference: tender.reference,
          })),
        });

        await tx.invoice.create({
          data: {
            id: invoice.id,
            tenantId: tenant,
            saleId: sale.id,
            invoiceNumber: invoice.invoiceNumber,
            invoiceType: invoice.invoiceType,
            sellerName: invoice.sellerName,
            sellerVatNumber: invoice.sellerVatNumber,
            buyerName: invoice.buyerName,
            buyerVatNumber: invoice.buyerVatNumber,
            netMinor: BigInt(invoice.netMinor),
            vatMinor: BigInt(invoice.vatMinor),
            totalMinor: BigInt(invoice.totalMinor),
            currency: invoice.currency,
            issuedAt: new Date(invoice.issuedAt),
          },
        });

        if (invoice.taxBreakdown.length > 0) {
          await tx.invoiceTaxBreakdown.createMany({
            data: invoice.taxBreakdown.map((bucket, index) => ({
              // The bucket has no identity of its own; it is a projection of
              // the invoice, so its id is derived from the invoice's and its
              // position rather than minted separately.
              id: bucketId(invoice.id, index),
              tenantId: tenant,
              invoiceId: invoice.id,
              vatBasisPoints: Number(bucket.vatBasisPoints),
              netMinor: BigInt(bucket.netMinor),
              vatMinor: BigInt(bucket.vatMinor),
            })),
          });
        }

        for (const movement of inventory) {
          await applyMovementWithin(tx, tenant, movement);
        }

        if (cashMovement !== null) {
          await tx.cashMovement.create({
            data: {
              id: cashMovement.id,
              tenantId: tenant,
              shiftId: cashMovement.shiftId,
              kind: cashMovement.kind,
              amountMinor: BigInt(cashMovement.amountMinor),
              reason: cashMovement.reason,
              actorUserId: cashMovement.actorUserId,
              occurredAt: new Date(cashMovement.occurredAt),
            },
          });
        }

        const row = await loadSale(tx, tenant, { id: sale.id });
        if (row === null) {
          throw new DatabaseError('The sale just written could not be read back.');
        }
        return saleToDomain(scope, row);
      });
    },
  };
}

/**
 * A deterministic UUID for a tax bucket, derived from its invoice.
 *
 * Deterministic so that replaying the same invoice cannot produce a second set
 * of buckets under new ids. The last two hex digits of the invoice's id are
 * replaced by the bucket index, which keeps the value a syntactically valid
 * UUID and unique within the invoice.
 */
export function bucketId(invoiceId: string, index: number): string {
  if (index > 0xff) {
    throw new DatabaseError('An invoice with more than 256 tax buckets is not a real invoice.');
  }
  const suffix = index.toString(16).padStart(2, '0');
  return `${invoiceId.slice(0, invoiceId.length - 2)}${suffix}`;
}
EOF

cat << 'EOF' > packages/database/src/repositories/idempotency-repository.ts
import { withTenant } from '../tenant-context.js';
import { isoOrNull, oneOf, scoped, tenantParam } from './mapping.js';
import type {
  IdempotencyRecord,
  IdempotencyRepository,
  IdempotencyReservation,
  IdempotencyStatus,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';

const STATUSES: readonly IdempotencyStatus[] = ['reserved', 'completed', 'failed'];

interface KeyRow {
  id: string;
  tenantId: string;
  scope: string;
  operationId: string;
  status: string;
  resultType: string | null;
  resultId: string | null;
  requestHash: string | null;
  completedAt: Date | null;
}

function toDomain(scope: TenantScope, row: KeyRow): IdempotencyRecord {
  return {
    id: row.id,
    tenantId: scoped(scope, row.tenantId),
    scope: row.scope,
    operationId: row.operationId,
    status: oneOf(STATUSES, row.status, 'idempotency_keys.status'),
    resultType: row.resultType,
    resultId: row.resultId,
    requestHash: row.requestHash,
    completedAt: isoOrNull(row.completedAt),
  };
}

/**
 * Reservations for replayable operations.
 *
 * The reservation is created optimistically and lets the unique index decide.
 * A check-then-insert would race: two retries of the same checkout arriving
 * together would both read "not reserved" and both proceed.
 */
export function createIdempotencyRepository(prisma: PrismaClient): IdempotencyRepository {
  return {
    async find(
      scope: TenantScope,
      scopeKey: string,
      operationId: string,
    ): Promise<IdempotencyRecord | null> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: KeyRow | null = await tx.idempotencyKey.findFirst({
          where: { scope: scopeKey, operationId, tenantId: tenantParam(scope) },
        });
        return row === null ? null : toDomain(scope, row);
      });
    },

    async reserve(
      scope: TenantScope,
      reservation: IdempotencyReservation,
    ): Promise<IdempotencyRecord> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const row: KeyRow = await tx.idempotencyKey.create({
          data: {
            id: reservation.id,
            tenantId: tenantParam(scope),
            scope: reservation.scope,
            operationId: reservation.operationId,
            status: 'reserved',
            requestHash: reservation.requestHash,
          },
        });
        return toDomain(scope, row);
      });
    },

    async complete(
      scope: TenantScope,
      scopeKey: string,
      operationId: string,
      result: { readonly resultType: string; readonly resultId: string; readonly at: string },
    ): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        await tx.idempotencyKey.updateMany({
          where: {
            scope: scopeKey,
            operationId,
            tenantId: tenantParam(scope),
            status: 'reserved',
          },
          data: {
            status: 'completed',
            resultType: result.resultType,
            resultId: result.resultId,
            completedAt: new Date(result.at),
          },
        });
      });
    },
  };
}
EOF

cat << 'EOF' > packages/database/src/repositories/audit-repository.ts
import { withTenant } from '../tenant-context.js';
import { iso, tenantParam } from './mapping.js';
import type { AuditEventInput, AuditRepository, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

type Metadata = Readonly<Record<string, string | number | boolean | null>>;

interface AuditRow {
  id: string;
  actorUserId: string | null;
  branchId: string | null;
  terminalId: string | null;
  eventType: string;
  entityType: string;
  entityId: string | null;
  metadata: unknown;
  occurredAt: Date;
}

/**
 * Narrow the JSON column back to the shape the port promises.
 *
 * Anything that is not a flat object of primitives is dropped rather than
 * coerced. An audit row whose metadata has been written by some other tool is
 * still worth showing — the actor, the event and the time are the parts that
 * matter — and guessing at a nested structure would be worse than omitting it.
 */
function narrowMetadata(value: unknown): Metadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'number' ||
      typeof entry === 'boolean'
    ) {
      out[key] = entry;
    }
  }
  return out;
}

/**
 * Append-only. There is no update and no delete, here or in the schema —
 * an audit trail a caller can rewrite is not one.
 */
export function createAuditRepository(prisma: PrismaClient): AuditRepository {
  return {
    async append(scope: TenantScope, event: AuditEventInput): Promise<void> {
      await withTenant(prisma, scope.tenantId, async (tx) => {
        await tx.auditEvent.create({
          data: {
            id: event.id,
            tenantId: tenantParam(scope),
            actorUserId: event.actorUserId,
            branchId: event.branchId,
            terminalId: event.terminalId,
            eventType: event.eventType,
            entityType: event.entityType,
            entityId: event.entityId,
            // Omitted rather than set to null: a JSON column takes a database
            // NULL by absence, and Prisma reads an explicit null as the JSON
            // value `null`, which is a different thing.
            ...(event.metadata === null ? {} : { metadata: { ...event.metadata } }),
            occurredAt: new Date(event.occurredAt),
          },
        });
      });
    },

    async list(scope: TenantScope, limit: number): Promise<readonly AuditEventInput[]> {
      return withTenant(prisma, scope.tenantId, async (tx) => {
        const rows: AuditRow[] = await tx.auditEvent.findMany({
          where: { tenantId: tenantParam(scope) },
          orderBy: { occurredAt: 'desc' },
          take: limit,
        });
        return rows.map((row) => ({
          id: row.id,
          actorUserId: row.actorUserId,
          branchId: row.branchId,
          terminalId: row.terminalId,
          eventType: row.eventType,
          entityType: row.entityType,
          entityId: row.entityId,
          metadata: narrowMetadata(row.metadata),
          occurredAt: iso(row.occurredAt),
        }));
      });
    },
  };
}
EOF

cat << 'EOF' > packages/database/src/index.ts
export { createPrismaClient } from './client.js';
export type { PrismaClient } from './client.js';

export { withTenant, withoutTenant } from './tenant-context.js';
export type { TransactionClient } from './tenant-context.js';

export { DatabaseError, TenantContextError } from './errors.js';

export { createTenantRepository } from './repositories/tenant-repository.js';
export { createBranchRepository } from './repositories/branch-repository.js';
export { createTerminalRepository } from './repositories/terminal-repository.js';
export {
  createProductRepository,
  createGlobalCatalogRepository,
} from './repositories/product-repository.js';
// `applyMovementWithin` is deliberately not re-exported. It takes a raw tenant
// string and an open transaction, which is safe only because the sale
// repository calls it from inside withTenant. On the public surface it would
// be a way to write stock into an arbitrary tenant.
export { createInventoryRepository } from './repositories/inventory-repository.js';
export { createCustomerRepository } from './repositories/customer-repository.js';
export { createShiftRepository } from './repositories/shift-repository.js';
export { createSaleRepository } from './repositories/sale-repository.js';
export { createIdempotencyRepository } from './repositories/idempotency-repository.js';
export { createAuditRepository } from './repositories/audit-repository.js';
EOF

say "Tests — schema and RLS coverage"

cat << 'EOF' > packages/database/src/__tests__/saas-schema.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static verification of the SaaS schema and its tenancy boundary.
 *
 * These assertions run without a database on purpose, and they do not claim to
 * prove that PostgreSQL blocks a cross-tenant read at runtime — that needs a
 * live server and belongs in an integration suite. What they prove is narrower
 * and still worth having on every push: that nobody has added a tenant-owned
 * table without protecting it, and that every policy is written the way it has
 * to be written to work.
 *
 * The tenant-owned table list is *derived from the schema*, not hand-written.
 * A hand-written list is exactly the thing that goes stale the week someone
 * adds a table.
 */

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, '../../prisma');
const schema = readFileSync(join(prismaDir, 'schema.prisma'), 'utf8');
const migration = readFileSync(
  join(prismaDir, 'migrations/20260808120000_saas_foundation/migration.sql'),
  'utf8',
);

interface ParsedModel {
  readonly name: string;
  readonly table: string;
  readonly body: string;
  readonly hasTenantId: boolean;
}

function parseModels(source: string): readonly ParsedModel[] {
  const models: ParsedModel[] = [];
  for (const match of source.matchAll(/\nmodel\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const name = match[1] ?? '';
    const body = match[2] ?? '';
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    models.push({ name, table, body, hasTenantId: /^\s*tenantId\s+String/m.test(body) });
  }
  return models;
}

const models = parseModels(schema);

/**
 * The two documented exceptions (ADR-0004).
 *
 * `permissions` is the application's own vocabulary — identical for every
 * tenant, derived from nobody's data. `global_catalog_items` is the national
 * barcode catalogue: shared reference data that would otherwise be duplicated
 * hundreds of thousands of times per merchant.
 */
const GLOBAL_TABLES = ['permissions', 'global_catalog_items'];

/** The tenant row is keyed on its own id; everything else carries tenantId. */
const SELF_KEYED = ['tenants'];

const tenantOwned = models.filter((model) => !GLOBAL_TABLES.includes(model.table));
const tenantOwnedTables = tenantOwned.map((model) => model.table);

describe('schema shape', () => {
  it('parses every model in the schema', () => {
    // A parser that silently matched nothing would make every test below pass.
    expect(models.length).toBeGreaterThanOrEqual(30);
  });

  it.each(
    tenantOwned.filter((model) => !SELF_KEYED.includes(model.table)).map((model) => model.name),
  )('%s carries tenantId', (name) => {
    const model = models.find((candidate) => candidate.name === name);
    expect(model?.hasTenantId).toBe(true);
  });

  it.each(GLOBAL_TABLES)('%s is global by design and carries no tenantId', (table) => {
    const model = models.find((candidate) => candidate.table === table);
    expect(model).toBeDefined();
    expect(model?.hasTenantId).toBe(false);
  });

  it('indexes tenantId first on every tenant-scoped key', () => {
    // A composite index whose leading column is not tenantId cannot serve a
    // tenant-filtered query, so the planner falls back to scanning across
    // every merchant's rows.
    for (const match of schema.matchAll(/@@(?:index|unique|id)\(\[([^\]]+)\]/g)) {
      const columns = (match[1] ?? '').split(',').map((column) => column.trim());
      if (columns.includes('tenantId')) {
        expect(columns[0]).toBe('tenantId');
      }
    }
  });
});

describe('money, quantity and rate columns', () => {
  it('declares no Float or Decimal column anywhere', () => {
    const declarations = [...schema.matchAll(/^\s{2}(\w+)\s+(Float|Decimal)\b/gm)];
    expect(declarations).toEqual([]);
  });

  it('stores every money column as BigInt minor units', () => {
    const moneyColumns = [...schema.matchAll(/^\s*(\w*[Mm]inor)\s+(\w+)/gm)];
    expect(moneyColumns.length).toBeGreaterThan(20);
    for (const column of moneyColumns) {
      expect(column[2], column[1]).toBe('BigInt');
    }
  });

  it('stores every quantity as a scaled BigInt, never a float', () => {
    // A grocery scale reads 0.125 kg. A float weight multiplied by a price in
    // halalas drifts exactly as a float price does (ADR-0002).
    const quantities = [...schema.matchAll(/^\s*(quantityScaled)\s+(\w+)/gm)];
    expect(quantities.length).toBeGreaterThanOrEqual(3);
    for (const column of quantities) {
      expect(column[2]).toBe('BigInt');
    }
  });

  it('stores every rate as an integer basis-point column', () => {
    const rates = [...schema.matchAll(/^\s*(\w*[Bb]asisPoints)\s+(\w+)/gm)];
    expect(rates.length).toBeGreaterThanOrEqual(5);
    for (const column of rates) {
      expect(column[2], column[1]).toBe('Int');
    }
  });
});

describe('row-level security', () => {
  it.each(tenantOwnedTables)('enables RLS on %s', (table) => {
    expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  });

  it.each(tenantOwnedTables)('forces RLS on %s so the owner cannot bypass it', (table) => {
    // Without FORCE the owning role ignores every policy, and the application
    // role is very often the owner.
    expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  });

  it.each(tenantOwnedTables)('defines an isolation policy for %s', (table) => {
    expect(migration).toMatch(new RegExp(`CREATE POLICY "\\w+" ON "${table}"`));
  });

  it('gives every policy both USING and WITH CHECK, and no table is missed', () => {
    // USING alone governs reads. Without WITH CHECK a caller could UPDATE a
    // visible row and reassign it to another tenant.
    // Split on the statement, not the phrase: the file's own commentary
    // mentions CREATE POLICY, and counting that would inflate the total.
    const policies = migration.split(/\nCREATE POLICY "/).slice(1);
    expect(policies.length).toBe(tenantOwnedTables.length);
    for (const policy of policies) {
      const body = policy.split(';')[0] ?? '';
      expect(body).toContain('USING');
      expect(body).toContain('WITH CHECK');
      expect(body).toContain('current_tenant_id()');
    }
  });

  it('recreates each policy rather than assuming it is absent', () => {
    // Phase 0 already created policies on tenants and products, and
    // PostgreSQL has no CREATE POLICY ... IF NOT EXISTS, so a bare CREATE
    // would abort this migration on any database that has run Phase 0.
    const pairs = [
      ...migration.matchAll(/DROP POLICY IF EXISTS "(\w+)" ON "(\w+)";\nCREATE POLICY "\1" ON "\2"/g),
    ];
    expect(pairs.length).toBe(tenantOwnedTables.length);
  });

  it('keys the tenants policy on its own id, not on a tenantId column', () => {
    expect(migration).toMatch(
      /CREATE POLICY "tenants_isolation" ON "tenants"\s+USING \("id" = current_tenant_id\(\)\)/,
    );
  });

  it.each(GLOBAL_TABLES)('leaves %s outside RLS deliberately', (table) => {
    expect(migration).not.toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    // and says why, so the omission cannot be mistaken for an oversight
    expect(migration).toContain('ADR-0004');
  });

  it('resolves tenant context from a session setting, not a literal', () => {
    expect(migration).toContain('current_tenant_id()');
    expect(migration).not.toMatch(/current_setting\('app\.tenant_id', FALSE\)/);
  });

  it('drops nothing', () => {
    // A forward-only migration that drops a table takes a merchant's history
    // with it.
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|DATABASE|SCHEMA|COLUMN)\b/i);
  });
});

describe('integrity constraints', () => {
  it('constrains every VAT column to 0..10000 basis points', () => {
    const ranges = [...migration.matchAll(/"vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000/g)];
    expect(ranges.length).toBeGreaterThanOrEqual(3);
  });

  it('makes a sale that does not balance impossible to store', () => {
    expect(migration).toContain('"netMinor" + "vatMinor" = "totalMinor"');
    expect(migration).toContain('"tenderedMinor" - "changeMinor" = "totalMinor"');
  });

  it('permits change on cash tenders only', () => {
    // A card terminal has no mechanism to hand money back.
    expect(migration).toContain(`CHECK ("changeMinor" = 0 OR "kind" = 'cash')`);
  });

  it('enforces the sign of a cash movement at the column', () => {
    expect(migration).toContain('cash_movements_sign');
  });

  it('makes a barcode unique within a tenant, never globally', () => {
    // Two merchants may legitimately stock the same EAN; a global constraint
    // would make the second one fail to onboard.
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "product_barcodes_tenantId_barcode_key" ON "product_barcodes"("tenantId", "barcode")',
    );
    expect(migration).not.toMatch(/UNIQUE INDEX "\w+" ON "product_barcodes"\("barcode"\)/);
  });

  it('makes a replayed operation collide instead of ringing up a second sale', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "idempotency_keys_tenantId_scope_operationId_key"',
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "sales_tenantId_operationId_key"');
  });

  it('gives the inventory balance a natural primary key', () => {
    // A surrogate id would allow two disagreeing balances for one product.
    expect(migration).toContain('PRIMARY KEY ("tenantId", "branchId", "productId")');
  });
});

describe('tenant-consistent foreign keys', () => {
  /**
   * RLS protects a row; it does not protect a reference. A sale owned by
   * tenant A, visible only to A, could still name a branch owned by B if the
   * foreign key pointed at branches(id) alone — that key proves the branch
   * exists and nothing more.
   *
   * The fix is structural: every tenant-owned parent carries a unique key on
   * (tenantId, id), and every child references that pair. These assertions
   * exist so a relationship added later cannot quietly go back to referencing
   * an id on its own.
   */

  /** Models with no tenant, whose children reference them by id alone. */
  const GLOBAL_MODELS = ['Permission', 'GlobalCatalogItem'];

  interface Reference {
    readonly model: string;
    readonly field: string;
    readonly target: string;
    readonly fields: string;
    readonly references: string;
  }

  const references: Reference[] = [];
  for (const model of models) {
    for (const match of model.body.matchAll(
      /^\s*(\w+)\s+(\w+)\??\s+@relation\(fields: \[([^\]]+)\], references: \[([^\]]+)\]/gm,
    )) {
      references.push({
        model: model.name,
        field: match[1] ?? '',
        target: match[2] ?? '',
        fields: (match[3] ?? '').replace(/\s+/g, ' ').trim(),
        references: (match[4] ?? '').replace(/\s+/g, ' ').trim(),
      });
    }
  }

  /** References to a tenant-owned parent that is not the Tenant row itself. */
  const tenantOwnedRefs = references.filter(
    (reference) => reference.target !== 'Tenant' && !GLOBAL_MODELS.includes(reference.target),
  );

  it('finds the relations it is meant to police', () => {
    // A parser that matched nothing would make every assertion below vacuous.
    expect(tenantOwnedRefs.length).toBeGreaterThanOrEqual(30);
  });

  it.each(tenantOwnedRefs.map((reference) => `${reference.model}.${reference.field}`))(
    '%s references its parent by (tenantId, id), not by id alone',
    (label) => {
      const reference = tenantOwnedRefs.find(
        (candidate) => `${candidate.model}.${candidate.field}` === label,
      );
      expect(reference?.references).toBe('tenantId, id');
      expect(reference?.fields.startsWith('tenantId, ')).toBe(true);
    },
  );

  it('gives every referenced parent the (tenantId, id) key the child points at', () => {
    const parents = [...new Set(tenantOwnedRefs.map((reference) => reference.target))];
    expect(parents.length).toBeGreaterThanOrEqual(10);
    for (const parent of parents) {
      const model = models.find((candidate) => candidate.name === parent);
      expect(model?.body, `${parent} has no tenant-consistency key`).toContain(
        '@@unique([tenantId, id])',
      );
    }
  });

  it('references a global parent by its own key, since it has no tenant', () => {
    const globalRefs = references.filter((reference) => GLOBAL_MODELS.includes(reference.target));
    expect(globalRefs.length).toBeGreaterThan(0);
    for (const reference of globalRefs) {
      expect(reference.references).not.toContain('tenantId');
    }
  });

  it('leaves no single-column foreign key to a tenant-owned table in the migration', () => {
    const globalTables = ['tenants', 'permissions', 'global_catalog_items'];
    const offenders = [
      ...migration.matchAll(/FOREIGN KEY \("(\w+)"\) REFERENCES "(\w+)"\("(\w+)"\)/g),
    ].filter((match) => !globalTables.includes(match[2] ?? ''));
    expect(offenders.map((match) => `${match[2]}.${match[3]}`)).toEqual([]);
  });

  it('writes every composite foreign key with tenantId leading', () => {
    const composite = [
      ...migration.matchAll(
        /FOREIGN KEY \("(\w+)", "(\w+)"\) REFERENCES "(\w+)"\("(\w+)", "(\w+)"\)/g,
      ),
    ];
    expect(composite.length).toBeGreaterThanOrEqual(30);
    for (const match of composite) {
      expect(match[1]).toBe('tenantId');
      expect(match[4]).toBe('tenantId');
      expect(match[5]).toBe('id');
    }
  });

  it('creates the unique key each composite foreign key needs as its target', () => {
    const targets = [
      ...new Set(
        [
          ...migration.matchAll(/REFERENCES "(\w+)"\("tenantId", "id"\)/g),
        ].map((match) => match[1] ?? ''),
      ),
    ];
    expect(targets.length).toBeGreaterThanOrEqual(10);
    for (const table of targets) {
      expect(migration, `${table} has no (tenantId, id) unique index`).toMatch(
        new RegExp(`CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"${table}_tenantId_id_key"`),
      );
    }
  });

  it('refuses the delete rather than nulling a composite key', () => {
    // SET NULL on ("tenantId", "col") would null tenantId too, and tenantId is
    // NOT NULL. NO ACTION defers the check to end of statement, so a tenant
    // cascade still works while a dangling reference is still an error.
    const composite = migration.match(
      /FOREIGN KEY \("tenantId", "\w+"\) REFERENCES "\w+"\("tenantId", "id"\) ON DELETE (\w+(?: \w+)?)/g,
    );
    expect(composite?.length).toBeGreaterThanOrEqual(30);
    expect(migration).not.toMatch(
      /FOREIGN KEY \("tenantId", "\w+"\) REFERENCES "\w+"\("tenantId", "id"\) ON DELETE SET NULL/,
    );
  });
});

describe('sale snapshots', () => {
  const saleLine = models.find((model) => model.name === 'SaleLine');

  it.each(['sku', 'nameAr', 'unitPriceMinor', 'vatBasisPoints', 'quantityScaled'])(
    'snapshots %s onto the sale line',
    (column) => {
      // A finalized line must not read its description or price back from the
      // product: editing a product tomorrow would rewrite yesterday's invoice.
      expect(saleLine?.body).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
    },
  );

  it('keeps productId nullable so a deleted product cannot orphan a receipt', () => {
    expect(saleLine?.body).toMatch(/productId\s+String\?/);
  });

  it('snapshots the seller identity onto the invoice', () => {
    const invoice = models.find((model) => model.name === 'Invoice');
    expect(invoice?.body).toMatch(/^\s*sellerName\s/m);
    expect(invoice?.body).toMatch(/^\s*sellerVatNumber\s/m);
  });
});

describe('audit trail', () => {
  const audit = models.find((model) => model.name === 'AuditEvent');

  /** Field declarations only — the comments are allowed to say "password". */
  const fields = (audit?.body ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('/'))
    .join('\n');

  it.each(['tenantId', 'actorUserId', 'eventType', 'entityType', 'occurredAt'])(
    'records %s',
    (column) => {
      expect(fields).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
    },
  );

  it('carries no column that could hold a credential', () => {
    expect(fields).not.toMatch(/password|token|secret|apiKey/i);
  });
});
EOF

say "Tests — repository tenancy"

cat << 'EOF' > packages/database/src/__tests__/repository-tenancy.test.ts
import { describe, expect, it } from 'vitest';
import { basisPoints, tenantId } from '@korvi/domain';
import { createAuditRepository } from '../repositories/audit-repository.js';
import { createBranchRepository } from '../repositories/branch-repository.js';
import { createCustomerRepository } from '../repositories/customer-repository.js';
import { createIdempotencyRepository } from '../repositories/idempotency-repository.js';
import { createInventoryRepository } from '../repositories/inventory-repository.js';
import { createProductRepository } from '../repositories/product-repository.js';
import { createSaleRepository } from '../repositories/sale-repository.js';
import { createShiftRepository } from '../repositories/shift-repository.js';
import { createTenantRepository } from '../repositories/tenant-repository.js';
import { createTerminalRepository } from '../repositories/terminal-repository.js';
import type { RecordSaleInput, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

/**
 * What reaches the database, without a database.
 *
 * The fake records every model call a repository makes and every value bound
 * into the tenant-context statement. That is enough to prove the two things
 * this layer is responsible for:
 *
 *   every read and write is filtered by the scope's tenant, and
 *   every one of them runs inside a transaction that has already established
 *   `app.tenant_id`.
 *
 * It deliberately proves nothing about PostgreSQL's own behaviour. Whether RLS
 * actually blocks a cross-tenant read is a question for a live server, and
 * asserting it here would be asserting something this file cannot see.
 */

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const OTHER_TENANT = '018f3a1c-9b2e-7c4d-8e5f-ffffffffffff';
const scope: TenantScope = { tenantId: tenantId(TENANT) };
const AT = '2026-08-08T10:00:00.000Z';

interface Call {
  readonly model: string;
  readonly method: string;
  readonly args: Record<string, unknown>;
}

interface Fake {
  readonly client: PrismaClient;
  readonly calls: Call[];
  readonly contexts: unknown[];
}

/** Replies keyed by `model.method`, consumed in order, the last one repeating. */
type Replies = Record<string, readonly unknown[]>;

function fake(replies: Replies = {}): Fake {
  const calls: Call[] = [];
  const contexts: unknown[] = [];
  const cursor = new Map<string, number>();

  const reply = (model: string, method: string): unknown => {
    const key = `${model}.${method}`;
    const queue = replies[key];
    if (queue === undefined || queue.length === 0) {
      if (method === 'findMany') return [];
      if (method === 'createMany' || method === 'updateMany') return { count: 1 };
      return null;
    }
    const index = cursor.get(key) ?? 0;
    cursor.set(key, index + 1);
    return queue[Math.min(index, queue.length - 1)];
  };

  const tx = new Proxy(
    {},
    {
      get(_target, model: string | symbol): unknown {
        if (typeof model !== 'string') return undefined;
        if (model === '$executeRaw') {
          return (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
            contexts.push(values[0]);
            return Promise.resolve(1);
          };
        }
        return new Proxy(
          {},
          {
            get(_inner, method: string | symbol): unknown {
              if (typeof method !== 'string') return undefined;
              return (args: Record<string, unknown> = {}): Promise<unknown> => {
                calls.push({ model, method, args });
                return Promise.resolve(reply(model, method));
              };
            },
          },
        );
      },
    },
  );

  const client = {
    $transaction: (work: (t: unknown) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;

  return { client, calls, contexts };
}

/** JSON with bigint rendered rather than thrown on. */
function show(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
}

function branchRow(tenant = TENANT): Record<string, unknown> {
  return { id: 'b1', tenantId: tenant, code: '01', nameAr: 'الفرع', nameEn: null, isActive: true };
}

function productRow(): Record<string, unknown> {
  return {
    id: 'p1',
    tenantId: TENANT,
    categoryId: null,
    sku: 'SKU-1',
    nameAr: 'حليب',
    nameEn: 'Milk',
    productType: 'unit',
    unitLabel: 'each',
    priceMinor: 1150n,
    vatBasisPoints: 1500,
    trackInventory: true,
    isActive: true,
    barcodes: [
      { barcode: '6281000000001', isPrimary: true },
      { barcode: '6281000000002', isPrimary: false },
    ],
  };
}

/** Every operation this layer exposes, driven once. */
async function exerciseEverything(f: Fake): Promise<void> {
  const prisma = f.client;

  await createTenantRepository(prisma).current(scope);
  await createTenantRepository(prisma).settings(scope);
  await createBranchRepository(prisma).findById(scope, 'b1');
  await createBranchRepository(prisma).list(scope);
  await createTerminalRepository(prisma).findById(scope, 't1');
  await createTerminalRepository(prisma).findByCode(scope, '01');
  await createTerminalRepository(prisma).listForBranch(scope, 'b1');
  await createTerminalRepository(prisma).markSeen(scope, 't1', AT);
  await createProductRepository(prisma).findById(scope, 'p1');
  await createProductRepository(prisma).findBySku(scope, 'SKU-1');
  await createProductRepository(prisma).findByBarcode(scope, '6281000000001');
  await createProductRepository(prisma).list(scope, 10);
  await createInventoryRepository(prisma).balance(scope, 'b1', 'p1');
  await createInventoryRepository(prisma).listBalances(scope, 'b1', 10);
  await createInventoryRepository(prisma).applyMovement(scope, {
    id: 'm1',
    branchId: 'b1',
    productId: 'p1',
    kind: 'adjustment',
    quantityScaled: '-1000',
    reason: 'تالف',
    sourceType: null,
    sourceId: null,
    actorUserId: 'u1',
    occurredAt: AT,
  });
  await createCustomerRepository(prisma).findById(scope, 'c1');
  await createCustomerRepository(prisma).findByPhone(scope, '0500000000');
  await createCustomerRepository(prisma).list(scope, 10);
  await createCustomerRepository(prisma).create(scope, {
    id: 'c2',
    nameAr: 'عميل',
    nameEn: null,
    phone: '0500000001',
    email: null,
    vatNumber: null,
  });
  await createShiftRepository(prisma).findById(scope, 's1');
  await createShiftRepository(prisma).findOpenForTerminal(scope, 't1');
  await createSaleRepository(prisma).findById(scope, 'sale1');
  await createSaleRepository(prisma).findByOperationId(scope, 'op-1');
  await createSaleRepository(prisma).invoiceForSale(scope, 'sale1');
  await createIdempotencyRepository(prisma).find(scope, 'checkout', 'op-1');
  await createIdempotencyRepository(prisma).reserve(scope, {
    id: 'ik1',
    scope: 'checkout',
    operationId: 'op-1',
    requestHash: 'abc',
  });
  await createIdempotencyRepository(prisma).complete(scope, 'checkout', 'op-1', {
    resultType: 'sale',
    resultId: 'sale1',
    at: AT,
  });
  await createAuditRepository(prisma).append(scope, {
    id: 'a1',
    actorUserId: 'u1',
    branchId: 'b1',
    terminalId: 't1',
    eventType: 'sale.finalized',
    entityType: 'sale',
    entityId: 'sale1',
    metadata: { sequence: 12 },
    occurredAt: AT,
  });
  await createAuditRepository(prisma).list(scope, 10);
}

/** Replies rich enough that mapping code runs rather than short-circuiting. */
const FULL_REPLIES: Replies = {
  'inventoryBalance.upsert': [
    { tenantId: TENANT, branchId: 'b1', productId: 'p1', quantityScaled: -1000n },
  ],
  'customer.create': [
    {
      id: 'c2',
      tenantId: TENANT,
      nameAr: 'عميل',
      nameEn: null,
      phone: '0500000001',
      email: null,
      vatNumber: null,
      isActive: true,
    },
  ],
  'idempotencyKey.create': [
    {
      id: 'ik1',
      tenantId: TENANT,
      scope: 'checkout',
      operationId: 'op-1',
      status: 'reserved',
      resultType: null,
      resultId: null,
      requestHash: 'abc',
      completedAt: null,
    },
  ],
};

describe('every repository operation is tenant-scoped', () => {
  it('establishes the scope tenant on the transaction before any query', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    // One context statement per operation, and every one carries this tenant.
    expect(f.contexts.length).toBeGreaterThanOrEqual(25);
    for (const value of f.contexts) {
      expect(value).toBe(TENANT);
    }
  });

  it('binds the scope tenant into the where clause of every query that has one', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    const withWhere = f.calls.filter((call) => 'where' in call.args);
    expect(withWhere.length).toBeGreaterThanOrEqual(20);

    for (const call of withWhere) {
      const where = show(call.args['where']);
      expect(
        where.includes(TENANT),
        `${call.model}.${call.method} queried without a tenant filter: ${where}`,
      ).toBe(true);
    }
  });

  it('binds the scope tenant into the data of every row it writes', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    const creates = f.calls.filter(
      (call) => call.method === 'create' || call.method === 'createMany',
    );
    expect(creates.length).toBeGreaterThan(0);

    for (const call of creates) {
      const data = show(call.args['data']);
      expect(
        data.includes(TENANT),
        `${call.model}.${call.method} wrote a row with no tenant: ${data}`,
      ).toBe(true);
    }
  });

  it('never updates or deletes a row by primary key alone', async () => {
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    // `update` and `delete` take a unique selector, which cannot carry a
    // tenant filter alongside it — an id from another tenant would be written.
    // `updateMany` can, and is what the repositories use.
    for (const call of f.calls) {
      expect([call.model, call.method]).not.toContain('update');
      expect([call.model, call.method]).not.toContain('delete');
      expect([call.model, call.method]).not.toContain('deleteMany');
    }
  });

  it('takes no tenant id from anywhere but the scope', async () => {
    // Each repository method's arguments are ids, codes and values — never a
    // tenant. The only tenant that can reach a query is the scope's.
    const f = fake(FULL_REPLIES);
    await exerciseEverything(f);

    for (const call of f.calls) {
      const rendered = show(call.args);
      expect(rendered).not.toContain(OTHER_TENANT);
    }
  });

  it('reads a product with all of its barcodes', async () => {
    const f = fake({ 'product.findFirst': [productRow()] });
    const product = await createProductRepository(f.client).findById(scope, 'p1');

    expect(product?.primaryBarcode).toBe('6281000000001');
    expect(product?.barcodes).toEqual(['6281000000001', '6281000000002']);
    expect(product?.priceMinor).toBe('1150');
    expect(product?.vatBasisPoints).toBe(basisPoints(1500));
  });

  it('scopes a barcode lookup to the tenant, because barcodes are not globally unique', async () => {
    const f = fake({ 'product.findFirst': [productRow()] });
    await createProductRepository(f.client).findByBarcode(scope, '6281000000001');

    const call = f.calls.find((candidate) => candidate.model === 'product');
    const where = show(call?.args['where']);
    expect(where).toContain('6281000000001');
    expect(where).toContain(TENANT);
  });

  it('refuses a row belonging to another tenant instead of returning it', async () => {
    // Under RLS this row cannot reach us. If it ever does, the boundary is
    // broken, and returning it would be a cross-tenant leak.
    const f = fake({ 'branch.findFirst': [branchRow(OTHER_TENANT)] });
    await expect(createBranchRepository(f.client).findById(scope, 'b1')).rejects.toThrow(
      /another tenant/i,
    );
  });

  it('rejects a malformed tenant id before it reaches a query', async () => {
    const f = fake();
    const bad: TenantScope = { tenantId: tenantId('not-a-uuid') };
    await expect(createBranchRepository(f.client).list(bad)).rejects.toThrow(/tenant UUID/i);
    expect(f.calls).toHaveLength(0);
  });
});

describe('writes that must be atomic', () => {
  function saleInput(): RecordSaleInput {
    return {
      sale: {
        id: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
        branchId: 'b1',
        terminalId: 't1',
        shiftId: 's1',
        userId: 'u1',
        customerId: null,
        operationId: 'op-1',
        status: 'finalized',
        sequence: 12,
        priceMode: 'tax-inclusive',
        currency: 'SAR',
        grossMinor: '1150',
        lineDiscountMinor: '0',
        basketDiscountMinor: '0',
        netMinor: '1000',
        vatMinor: '150',
        totalMinor: '1150',
        tenderedMinor: '2000',
        changeMinor: '850',
        issuedAt: AT,
        lines: [
          {
            id: 'l1',
            lineNumber: 1,
            productId: 'p1',
            sku: 'SKU-1',
            nameAr: 'حليب',
            nameEn: 'Milk',
            unitPriceMinor: '1150',
            vatBasisPoints: basisPoints(1500),
            quantityScaled: '1000',
            grossMinor: '1150',
            lineDiscountMinor: '0',
            basketDiscountMinor: '0',
            netMinor: '1000',
            vatMinor: '150',
            totalMinor: '1150',
          },
        ],
        discounts: [],
        tenders: [
          { id: 'te1', kind: 'cash', amountMinor: '2000', changeMinor: '850', reference: null },
        ],
      },
      invoice: {
        id: '018f3a1c-9b2e-7c4d-8e5f-0000000000aa',
        saleId: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
        invoiceNumber: 'INV-000012',
        invoiceType: 'simplified',
        sellerName: 'متجر كورفي',
        sellerVatNumber: '300000000000003',
        buyerName: null,
        buyerVatNumber: null,
        netMinor: '1000',
        vatMinor: '150',
        totalMinor: '1150',
        currency: 'SAR',
        issuedAt: AT,
        taxBreakdown: [{ vatBasisPoints: basisPoints(1500), netMinor: '1000', vatMinor: '150' }],
      },
      inventory: [
        {
          id: 'm1',
          branchId: 'b1',
          productId: 'p1',
          kind: 'sale',
          quantityScaled: '-1000',
          reason: null,
          sourceType: 'sale',
          sourceId: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
          actorUserId: 'u1',
          occurredAt: AT,
        },
      ],
      cashMovement: {
        id: 'cm1',
        shiftId: 's1',
        kind: 'sale',
        amountMinor: '1150',
        reason: null,
        actorUserId: 'u1',
        occurredAt: AT,
      },
      idempotency: { id: 'ik1', scope: 'checkout', operationId: 'op-1', requestHash: 'abc' },
    };
  }

  const saleRow: Record<string, unknown> = {
    id: '018f3a1c-9b2e-7c4d-8e5f-000000000001',
    tenantId: TENANT,
    branchId: 'b1',
    terminalId: 't1',
    shiftId: 's1',
    userId: 'u1',
    customerId: null,
    operationId: 'op-1',
    status: 'finalized',
    sequence: 12,
    priceMode: 'tax-inclusive',
    currency: 'SAR',
    grossMinor: 1150n,
    lineDiscountMinor: 0n,
    basketDiscountMinor: 0n,
    netMinor: 1000n,
    vatMinor: 150n,
    totalMinor: 1150n,
    tenderedMinor: 2000n,
    changeMinor: 850n,
    issuedAt: new Date(AT),
    lines: [],
    discounts: [],
    tenders: [],
  };

  it('writes the sale, its invoice, its stock and its cash in one transaction', async () => {
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    // One context statement means one transaction: a crash cannot leave an
    // invoice without its sale, or stock consumed by a sale that never was.
    expect(f.contexts).toEqual([TENANT]);

    const touched = f.calls.map((call) => `${call.model}.${call.method}`);
    for (const expected of [
      'idempotencyKey.create',
      'sale.create',
      'saleLine.createMany',
      'tender.createMany',
      'invoice.create',
      'invoiceTaxBreakdown.createMany',
      'inventoryMovement.create',
      'inventoryBalance.upsert',
      'cashMovement.create',
    ]) {
      expect(touched).toContain(expected);
    }
  });

  it('reserves the operation id in the same transaction as the sale', async () => {
    // The unique index is what makes a retry collide instead of ringing up a
    // second sale; reserving in a separate transaction would leave a window.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    const reservation = f.calls.find((call) => call.model === 'idempotencyKey');
    const data = show(reservation?.args['data']);
    expect(data).toContain('op-1');
    expect(data).toContain('checkout');
    expect(data).toContain(TENANT);
  });

  it('moves stock by increment rather than by read-modify-write', async () => {
    // Two terminals selling the last unit would both read 1 and both write 0.
    const f = fake({ 'sale.findFirst': [saleRow] });
    await createSaleRepository(f.client).record(scope, saleInput());

    const upsert = f.calls.find((call) => call.method === 'upsert');
    expect(show(upsert?.args['update'])).toContain('increment');
  });

  it('reads the finalized sale back with money as strings', async () => {
    const f = fake({ 'sale.findFirst': [saleRow] });
    const sale = await createSaleRepository(f.client).record(scope, saleInput());

    expect(sale.totalMinor).toBe('1150');
    expect(sale.changeMinor).toBe('850');
    expect(sale.issuedAt).toBe(AT);
  });

  it('refuses to open a second shift on a till that already has one', async () => {
    const f = fake({ 'shift.findFirst': [{ id: 's-open', tenantId: TENANT, status: 'open' }] });
    await expect(
      createShiftRepository(f.client).open(scope, {
        id: 's2',
        branchId: 'b1',
        terminalId: 't1',
        userId: 'u1',
        openingFloatMinor: '20000',
        openedAt: AT,
        openingMovementId: 'cm0',
      }),
    ).rejects.toThrow(/already has an open shift/i);
  });

  it('refuses to close a shift that is not open', async () => {
    const f = fake({ 'shift.updateMany': [{ count: 0 }] });
    await expect(
      createShiftRepository(f.client).close(scope, {
        shiftId: 's1',
        declaredCashMinor: '31150',
        expectedCashMinor: '31000',
        varianceMinor: '150',
        closedAt: AT,
      }),
    ).rejects.toThrow(/not open/i);
  });

  it('refuses a cash movement against a closed shift', async () => {
    const f = fake({ 'shift.findFirst': [{ id: 's1', tenantId: TENANT, status: 'closed' }] });
    await expect(
      createShiftRepository(f.client).recordCashMovement(scope, {
        id: 'cm2',
        shiftId: 's1',
        kind: 'pay-out',
        amountMinor: '-5000',
        reason: 'مصروف',
        actorUserId: 'u1',
        occurredAt: AT,
      }),
    ).rejects.toThrow(/closed shift/i);
  });
});
EOF

say "Tests — mapping boundary and port shape"

cat << 'EOF' > packages/database/src/__tests__/mapping.test.ts
import { describe, expect, it } from 'vitest';
import { tenantId } from '@korvi/domain';
import {
  iso,
  isoOrNull,
  minor,
  minorOrNull,
  oneOf,
  rate,
  scoped,
  tenantParam,
} from '../repositories/mapping.js';
import { bucketId } from '../repositories/sale-repository.js';
import { DatabaseError } from '../errors.js';
import type { TenantScope } from '@korvi/domain';

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const scope: TenantScope = { tenantId: tenantId(TENANT) };

describe('the mapping boundary', () => {
  it('carries money out as a string, not a number', () => {
    // 9007199254740993 halalas is one above Number.MAX_SAFE_INTEGER; as a
    // number it would silently become an even value.
    expect(minor(9_007_199_254_740_993n)).toBe('9007199254740993');
    expect(minor(-1500n)).toBe('-1500');
    expect(minorOrNull(null)).toBeNull();
    expect(minorOrNull(0n)).toBe('0');
  });

  it('carries time out as ISO 8601 in UTC', () => {
    expect(iso(new Date('2026-08-08T10:00:00.000Z'))).toBe('2026-08-08T10:00:00.000Z');
    expect(isoOrNull(null)).toBeNull();
  });

  it('narrows a rate column into the branded type', () => {
    expect(rate(1500)).toBe(1500n);
  });

  it('rejects a rate column outside 0..10000 rather than printing it', () => {
    expect(() => rate(10_001)).toThrow();
  });

  it('narrows a known status column', () => {
    expect(oneOf(['open', 'closed'] as const, 'closed', 'shifts.status')).toBe('closed');
  });

  it('throws on a status column it has never heard of', () => {
    // Defaulting would take the wrong branch of a switch, silently.
    expect(() => oneOf(['cash', 'card'] as const, 'crypto', 'tenders.kind')).toThrow(DatabaseError);
  });

  it('accepts a row that belongs to the scope', () => {
    expect(scoped(scope, TENANT)).toBe(TENANT);
  });

  it('refuses a row that does not', () => {
    expect(() => scoped(scope, '018f3a1c-9b2e-7c4d-8e5f-ffffffffffff')).toThrow(/another tenant/i);
  });

  it('hands a query the scope tenant and nothing else', () => {
    expect(tenantParam(scope)).toBe(TENANT);
  });
});

describe('tax bucket identity', () => {
  const invoice = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';

  it('derives a stable id from the invoice, so a replay cannot duplicate buckets', () => {
    expect(bucketId(invoice, 0)).toBe(bucketId(invoice, 0));
    expect(bucketId(invoice, 0)).not.toBe(bucketId(invoice, 1));
  });

  it('keeps the derived id a syntactically valid UUID', () => {
    expect(bucketId(invoice, 15)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('refuses an invoice with more tax buckets than a real invoice has', () => {
    expect(() => bucketId(invoice, 300)).toThrow(DatabaseError);
  });
});
EOF

cat << 'EOF' > packages/database/src/__tests__/ports-shape.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shape of the persistence ports, read from the domain's source.
 *
 * It lives in @korvi/database rather than beside the file it inspects because
 * the domain package may not touch the filesystem (ADR-0001), and that rule is
 * worth more than the convenience of co-location.
 */

const here = dirname(fileURLToPath(import.meta.url));
const portsPath = join(here, '../../../domain/src/ports/persistence.ts');
const source = readFileSync(portsPath, 'utf8');
const indexSource = readFileSync(join(here, '../index.ts'), 'utf8');

/** Method signatures declared directly inside `interface Name { ... }`. */
function methodsOf(name: string): readonly string[] {
  const block = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? '';
  return [...block.matchAll(/^ {2}(\w+)\(([\s\S]*?)\):/gm)].map(
    (match) => `${match[1] ?? ''}(${(match[2] ?? '').replace(/\s+/g, ' ').trim()}`,
  );
}

const SCOPED_PORTS = [
  'TenantRepository',
  'BranchRepository',
  'TerminalRepository',
  'ProductRepository',
  'InventoryRepository',
  'CustomerRepository',
  'ShiftRepository',
  'SaleRepository',
  'IdempotencyRepository',
  'AuditRepository',
];

describe('every repository port', () => {
  it.each(SCOPED_PORTS)('%s declares at least one method', (name) => {
    expect(methodsOf(name).length).toBeGreaterThan(0);
  });

  it.each(SCOPED_PORTS)('takes a TenantScope as the first argument of every %s method', (name) => {
    for (const signature of methodsOf(name)) {
      expect(signature, `${name}.${signature}`).toContain('scope: TenantScope');
      expect(signature.indexOf('scope: TenantScope')).toBe(signature.indexOf('(') + 1);
    }
  });

  it('exposes exactly one unscoped port, and it reads shared reference data', () => {
    const unscoped = [...source.matchAll(/interface (\w+Repository) \{([\s\S]*?)\n\}/g)].filter(
      (match) => !(match[2] ?? '').includes('scope: TenantScope'),
    );
    expect(unscoped.map((match) => match[1])).toEqual(['GlobalCatalogRepository']);
  });

  it('offers no unscoped tenant lookup', () => {
    // One added "temporarily" becomes the method every later caller reaches
    // for. The gap is deliberate; see the note in the ports file.
    expect(source).not.toMatch(/^\s*(resolve|find)\w*\(slug/m);
    expect(source).not.toMatch(/interface TenantDirectory/);
  });
});

describe('what may cross the persistence boundary', () => {
  it('carries money and quantity across as strings', () => {
    // A bigint cannot be JSON-serialised; a number loses halalas above 2^53.
    expect(source).toMatch(/readonly priceMinor: string;/);
    expect(source).toMatch(/readonly totalMinor: string;/);
    expect(source).toMatch(/readonly quantityScaled: string;/);
    expect(source).not.toMatch(/Minor: number/);
    expect(source).not.toMatch(/quantityScaled: number/);
  });

  it('carries every rate as the branded, validated type', () => {
    expect(source).toMatch(/readonly vatBasisPoints: BasisPoints;/);
    expect(source).not.toMatch(/vatBasisPoints: number/);
  });

  it('lets no ORM type across', () => {
    expect(source).not.toMatch(/from '@?prisma/);
    expect(source).not.toMatch(/\bPrisma[A-Z]/);
    expect(source).not.toMatch(/\b(Decimal|JsonValue|InputJsonValue)\b/);
  });

  it('keeps the internal stock helper off the public surface', () => {
    // applyMovementWithin takes a raw tenant string and an open transaction.
    // Exported, it would be a way to write stock into an arbitrary tenant.
    expect(indexSource).not.toMatch(/^export \{[^}]*applyMovementWithin/m);
    expect(indexSource).toMatch(/createInventoryRepository/);
  });
});
EOF

cat << 'EOF' > packages/domain/src/ports/__tests__/persistence.test.ts
import { describe, expect, it } from 'vitest';
import { CrossTenantAccessError, assertSameTenant, tenantId } from '../persistence.js';
import { DomainError } from '../../errors.js';
import type { TenantScope } from '../persistence.js';

/**
 * The tenant assertion, exercised.
 *
 * No filesystem access here: the domain must stay isomorphic (ADR-0001), so
 * the tests that read the ports file as source live in @korvi/database.
 */

const TENANT = '018f3a1c-9b2e-7c4d-8e5f-0a1b2c3d4e5f';
const scope: TenantScope = { tenantId: tenantId(TENANT) };

describe('the tenant boundary in the ports', () => {
  it('accepts a row from the scope tenant', () => {
    expect(() => assertSameTenant(scope, TENANT)).not.toThrow();
  });

  it('throws rather than returning a row from another tenant', () => {
    // Returning null would hide a broken boundary; returning the row would
    // leak another merchant's data.
    expect(() => assertSameTenant(scope, '018f3a1c-9b2e-7c4d-8e5f-ffffffffffff')).toThrow(
      CrossTenantAccessError,
    );
  });

  it('compares the whole id, not a prefix', () => {
    expect(() => assertSameTenant(scope, `${TENANT}0`)).toThrow(CrossTenantAccessError);
    expect(() => assertSameTenant(scope, TENANT.slice(0, -1))).toThrow(CrossTenantAccessError);
  });

  it('is a DomainError, so a caller catching those catches this', () => {
    expect(new CrossTenantAccessError('x')).toBeInstanceOf(DomainError);
    expect(new CrossTenantAccessError('x').name).toBe('CrossTenantAccessError');
  });

  it('brands a tenant id without altering its value', () => {
    expect(tenantId(TENANT)).toBe(TENANT);
  });
});
EOF

say "Tests — live RLS and tenant-consistency (opt-in)"

cat << 'EOF' > packages/database/src/__tests__/rls-live.test.ts
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

/**
 * Live tenant isolation, against a real PostgreSQL server.
 *
 * The rest of the suite verifies that the migration *says* the right thing.
 * This file verifies that PostgreSQL *does* the right thing, which is a
 * different claim and the only one that matters in production. A policy can be
 * present and still not apply — the owner bypasses it without FORCE, and a
 * missing WITH CHECK leaves UPDATE free to hand a row to another tenant.
 *
 * Two boundaries are exercised here, and they are not the same boundary:
 *
 *   RLS decides which rows a tenant can see and write.
 *   Tenant-consistent foreign keys decide which rows a tenant may *point at*.
 *
 * A sale owned by A, visible only to A, could still name a branch owned by B
 * if the key pointed at branches(id) alone — RLS would never notice, because
 * the sale row itself is perfectly in order.
 *
 * It is opt-in. Set KORVI_TEST_DATABASE_URL to a throwaway database that has
 * had both migrations applied, and connect as the role the application uses —
 * not as a superuser, which bypasses RLS entirely and would make half of this
 * file pass for the wrong reason:
 *
 *   KORVI_TEST_DATABASE_URL=postgresql://korvi@localhost:5432/korvi_pos \
 *     npx vitest run packages/database/src/__tests__/rls-live.test.ts
 *
 * Without that variable the file skips, and says so, rather than pretending a
 * structural check proved runtime behaviour.
 */

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const here = dirname(fileURLToPath(import.meta.url));

/** Distinctive ids, so a stray row is recognisable and cleanup is targeted. */
const A = {
  tenant: '018f0000-0000-7000-8000-00000000000a',
  branch: '018f0000-0000-7000-8000-0000000000a1',
  user: '018f0000-0000-7000-8000-0000000000a2',
  terminal: '018f0000-0000-7000-8000-0000000000a3',
  shift: '018f0000-0000-7000-8000-0000000000a4',
  customer: '018f0000-0000-7000-8000-0000000000a5',
  category: '018f0000-0000-7000-8000-0000000000a6',
  product: '018f0000-0000-7000-8000-0000000000a7',
  sale: '018f0000-0000-7000-8000-0000000000a8',
  saleLine: '018f0000-0000-7000-8000-0000000000a9',
} as const;

const B = {
  tenant: '018f0000-0000-7000-8000-00000000000b',
  branch: '018f0000-0000-7000-8000-0000000000b1',
  user: '018f0000-0000-7000-8000-0000000000b2',
  terminal: '018f0000-0000-7000-8000-0000000000b3',
  shift: '018f0000-0000-7000-8000-0000000000b4',
  customer: '018f0000-0000-7000-8000-0000000000b5',
  category: '018f0000-0000-7000-8000-0000000000b6',
  product: '018f0000-0000-7000-8000-0000000000b7',
  sale: '018f0000-0000-7000-8000-0000000000b8',
  saleLine: '018f0000-0000-7000-8000-0000000000b9',
} as const;

/** Scratch ids for rows a test tries, and expects, to fail to create. */
const SCRATCH = {
  sale: '018f0000-0000-7000-8000-0000000000c1',
  saleLine: '018f0000-0000-7000-8000-0000000000c2',
  movement: '018f0000-0000-7000-8000-0000000000c3',
  barcode: '018f0000-0000-7000-8000-0000000000c4',
  price: '018f0000-0000-7000-8000-0000000000c5',
} as const;

/** Tables that are global by design (ADR-0004), plus Prisma's own ledger. */
const NOT_TENANT_OWNED = ['permissions', 'global_catalog_items', '_prisma_migrations'];

describe.skipIf(url === '')('tenant isolation, live', () => {
  let client: pg.Client;

  /** Run work with the tenant context set exactly as withTenant() does. */
  async function asTenant<T>(tenant: string, work: () => Promise<T>): Promise<T> {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, TRUE)", [tenant]);
    try {
      return await work();
    } finally {
      await client.query('COMMIT');
    }
  }

  /**
   * A statement expected to fail, run in its own transaction.
   *
   * A failed statement aborts the surrounding transaction, so each attempt is
   * isolated — otherwise the first expected rejection would poison every
   * assertion after it.
   */
  async function rejected(tenant: string, sql: string, values: unknown[] = []): Promise<string> {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', $1, TRUE)", [tenant]);
    try {
      await client.query(sql, values);
      await client.query('ROLLBACK');
      return '';
    } catch (error) {
      await client.query('ROLLBACK');
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function removeTenant(tenant: string): Promise<void> {
    await asTenant(tenant, async () => {
      await client.query('DELETE FROM "tenants" WHERE "id" = $1', [tenant]);
    });
  }

  /** Everything one tenant needs before a sale can exist. */
  async function seed(t: typeof A, slug: string): Promise<void> {
    await asTenant(t.tenant, async () => {
      await client.query(
        `INSERT INTO "tenants" ("id","name","slug","status","updatedAt")
         VALUES ($1,$2,$3,'active', now())`,
        [t.tenant, `Tenant ${slug}`, slug],
      );
      await client.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'01','الفرع', now())`,
        [t.branch, t.tenant],
      );
      await client.query(
        `INSERT INTO "users" ("id","tenantId","email","displayName","updatedAt")
         VALUES ($1,$2,$3,'كاشير', now())`,
        [t.user, t.tenant, `cashier@${slug}.test`],
      );
      await client.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'T1','صندوق', now())`,
        [t.terminal, t.tenant, t.branch],
      );
      await client.query(
        `INSERT INTO "shifts" ("id","tenantId","branchId","terminalId","userId","openingFloatMinor","openedAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,20000, now(), now())`,
        [t.shift, t.tenant, t.branch, t.terminal, t.user],
      );
      await client.query(
        `INSERT INTO "customers" ("id","tenantId","nameAr","updatedAt")
         VALUES ($1,$2,'عميل', now())`,
        [t.customer, t.tenant],
      );
      await client.query(
        `INSERT INTO "categories" ("id","tenantId","nameAr","updatedAt")
         VALUES ($1,$2,'ألبان', now())`,
        [t.category, t.tenant],
      );
      await client.query(
        `INSERT INTO "products" ("id","tenantId","categoryId","sku","nameAr","priceMinor","vatBasisPoints","updatedAt")
         VALUES ($1,$2,$3,$4,'حليب',1150,1500, now())`,
        [t.product, t.tenant, t.category, `SKU-${slug}`],
      );
    });
  }

  /**
   * A sale whose figures satisfy every reconciliation constraint.
   *
   * The receipt sequence is a parameter because it is unique per branch: two
   * attempts sharing one would collide on that key first, and the assertion
   * would then be reading the wrong rejection.
   */
  function saleSql(): string {
    return `INSERT INTO "sales"
      ("id","tenantId","branchId","terminalId","shiftId","userId","customerId","operationId",
       "sequence","priceMode","grossMinor","lineDiscountMinor","basketDiscountMinor",
       "netMinor","vatMinor","totalMinor","tenderedMinor","changeMinor","issuedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'tax-inclusive',1150,0,0,1000,150,1150,1150,0, now())`;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();

    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await seed(A, 'rls-live-a');
    await seed(B, 'rls-live-b');

    // The positive path, created once and asserted by its own test below.
    await asTenant(A.tenant, async () => {
      await client.query(saleSql(), [
        A.sale,
        A.tenant,
        A.branch,
        A.terminal,
        A.shift,
        A.user,
        A.customer,
        'op-live-a',
        1,
      ]);
      await client.query(
        `INSERT INTO "sale_lines"
          ("id","tenantId","saleId","productId","lineNumber","sku","nameAr",
           "unitPriceMinor","vatBasisPoints","quantityScaled",
           "grossMinor","lineDiscountMinor","basketDiscountMinor","netMinor","vatMinor","totalMinor")
         VALUES ($1,$2,$3,$4,1,'SKU-rls-live-a','حليب',1150,1500,1000,1150,0,0,1000,150,1150)`,
        [A.saleLine, A.tenant, A.sale, A.product],
      );
    });
  });

  afterAll(async () => {
    await removeTenant(A.tenant);
    await removeTenant(B.tenant);
    await client.end();
  });

  // -------------------------------------------------------------------------
  // Row-level security
  // -------------------------------------------------------------------------

  it('is not running as a superuser, which would bypass every policy', async () => {
    const result = await client.query<{ usesuper: boolean }>(
      'SELECT usesuper FROM pg_user WHERE usename = current_user',
    );
    expect(result.rows[0]?.usesuper).toBe(false);
  });

  it('enables and forces RLS on every tenant-owned table', async () => {
    const result = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY c.relname`,
    );

    const tenantOwned = result.rows.filter((row) => !NOT_TENANT_OWNED.includes(row.relname));
    expect(tenantOwned.length).toBeGreaterThanOrEqual(29);

    for (const row of tenantOwned) {
      expect(row.relrowsecurity, `${row.relname} has RLS disabled`).toBe(true);
      // Without FORCE the owner ignores every policy, and the application role
      // owns these tables.
      expect(row.relforcerowsecurity, `${row.relname} does not force RLS`).toBe(true);
    }
  });

  it('gives every tenant-owned table a policy with both USING and WITH CHECK', async () => {
    const result = await client.query<{
      tablename: string;
      qual: string | null;
      with_check: string | null;
    }>(`SELECT tablename, qual, with_check FROM pg_policies WHERE schemaname = 'public'`);

    const covered = new Set(result.rows.map((row) => row.tablename));
    expect(covered.size).toBeGreaterThanOrEqual(29);

    for (const row of result.rows) {
      expect(row.qual, `${row.tablename} policy has no USING`).not.toBeNull();
      expect(row.with_check, `${row.tablename} policy has no WITH CHECK`).not.toBeNull();
    }

    for (const table of NOT_TENANT_OWNED) {
      expect(covered.has(table)).toBe(false);
    }
  });

  it('shows a tenant only its own rows', async () => {
    const seen = await asTenant(A.tenant, async () => {
      const result = await client.query<{ id: string }>('SELECT "id" FROM "products"');
      return result.rows.map((row) => row.id);
    });
    expect(seen).toContain(A.product);
    expect(seen).not.toContain(B.product);
  });

  it('returns nothing for another tenant’s row, even asked for by primary key', async () => {
    const rows = await asTenant(A.tenant, async () => {
      const result = await client.query('SELECT "id" FROM "products" WHERE "id" = $1', [B.product]);
      return result.rowCount;
    });
    expect(rows).toBe(0);
  });

  it('shows nothing at all with no tenant context', async () => {
    // A request that forgot to establish context sees an empty database, not
    // everybody's data. Deny by default.
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', '', TRUE)");
    const result = await client.query('SELECT "id" FROM "products"');
    await client.query('COMMIT');
    expect(result.rowCount).toBe(0);
  });

  it('refuses an insert that names another tenant', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "products" ("id","tenantId","sku","nameAr","priceMinor","vatBasisPoints","updatedAt")
       VALUES ($1,$2,'X-1','منتج',100,1500, now())`,
      [SCRATCH.sale, B.tenant],
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('refuses to reassign a visible row to another tenant', async () => {
    // This is the one USING alone would allow: the row is visible, so the
    // UPDATE matches, and without WITH CHECK the new tenantId is accepted.
    const message = await rejected(
      A.tenant,
      'UPDATE "products" SET "tenantId" = $1 WHERE "id" = $2',
      [B.tenant, A.product],
    );
    expect(message).toMatch(/row-level security/i);
  });

  it('cannot delete another tenant’s row', async () => {
    const deleted = await asTenant(A.tenant, async () => {
      const result = await client.query('DELETE FROM "products" WHERE "id" = $1', [B.product]);
      return result.rowCount;
    });
    expect(deleted).toBe(0);

    const survived = await asTenant(B.tenant, async () => {
      const result = await client.query('SELECT "id" FROM "products" WHERE "id" = $1', [B.product]);
      return result.rowCount;
    });
    expect(survived).toBe(1);
  });

  it('applies the same rule to the tenants table itself', async () => {
    const rows = await asTenant(A.tenant, async () => {
      const result = await client.query<{ id: string }>('SELECT "id" FROM "tenants"');
      return result.rows.map((row) => row.id);
    });
    expect(rows).toEqual([A.tenant]);
  });

  it('leaves the global catalogue readable without a tenant', async () => {
    // Shared reference data. Readable with no context is the intended
    // behaviour, not an oversight (ADR-0004).
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.tenant_id', '', TRUE)");
    const result = await client.query('SELECT count(*)::int AS n FROM "global_catalog_items"');
    await client.query('COMMIT');
    expect(result.rowCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Tenant-consistent foreign keys
  // -------------------------------------------------------------------------
  //
  // Every attempt below is a row that RLS is perfectly happy with: correct
  // tenantId, visible to the tenant making it, passing every policy. The only
  // thing wrong is what it points at. If a plain foreign key to parent(id)
  // were still in place, every one of these would succeed.

  it('accepts a sale whose every reference belongs to the same tenant', async () => {
    const sale = await asTenant(A.tenant, async () => {
      const result = await client.query<{
        branchId: string;
        terminalId: string;
        shiftId: string;
        userId: string;
        customerId: string;
      }>('SELECT "branchId","terminalId","shiftId","userId","customerId" FROM "sales" WHERE "id" = $1', [
        A.sale,
      ]);
      return result.rows[0];
    });

    expect(sale).toEqual({
      branchId: A.branch,
      terminalId: A.terminal,
      shiftId: A.shift,
      userId: A.user,
      customerId: A.customer,
    });

    const line = await asTenant(A.tenant, async () => {
      const result = await client.query<{ productId: string }>(
        'SELECT "productId" FROM "sale_lines" WHERE "id" = $1',
        [A.saleLine],
      );
      return result.rows[0]?.productId;
    });
    expect(line).toBe(A.product);
  });

  it('refuses a sale that names another tenant’s branch', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      B.branch,
      A.terminal,
      A.shift,
      A.user,
      null,
      'op-cross-branch',
      2,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_branchId_fkey"/);
  });

  it('refuses a sale that names another tenant’s terminal', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      A.branch,
      B.terminal,
      A.shift,
      A.user,
      null,
      'op-cross-terminal',
      3,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_terminalId_fkey"/);
  });

  it('refuses a sale that names another tenant’s shift', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      A.branch,
      A.terminal,
      B.shift,
      A.user,
      null,
      'op-cross-shift',
      4,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_shiftId_fkey"/);
  });

  it('refuses a sale that names another tenant’s user', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      A.branch,
      A.terminal,
      A.shift,
      B.user,
      null,
      'op-cross-user',
      5,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_userId_fkey"/);
  });

  it('refuses a sale that names another tenant’s customer', async () => {
    const message = await rejected(A.tenant, saleSql(), [
      SCRATCH.sale,
      A.tenant,
      A.branch,
      A.terminal,
      A.shift,
      A.user,
      B.customer,
      'op-cross-customer',
      6,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_customerId_fkey"/);
  });

  it('refuses a sale line that names another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "sale_lines"
        ("id","tenantId","saleId","productId","lineNumber","sku","nameAr",
         "unitPriceMinor","vatBasisPoints","quantityScaled",
         "grossMinor","lineDiscountMinor","basketDiscountMinor","netMinor","vatMinor","totalMinor")
       VALUES ($1,$2,$3,$4,2,'X','منتج',1150,1500,1000,1150,0,0,1000,150,1150)`,
      [SCRATCH.saleLine, A.tenant, A.sale, B.product],
    );
    expect(message).toMatch(/foreign key constraint "sale_lines_tenantId_productId_fkey"/);
  });

  it('refuses a sale line attached to another tenant’s sale', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "sale_lines"
        ("id","tenantId","saleId","productId","lineNumber","sku","nameAr",
         "unitPriceMinor","vatBasisPoints","quantityScaled",
         "grossMinor","lineDiscountMinor","basketDiscountMinor","netMinor","vatMinor","totalMinor")
       VALUES ($1,$2,$3,$4,3,'X','منتج',1150,1500,1000,1150,0,0,1000,150,1150)`,
      [SCRATCH.saleLine, A.tenant, B.sale, A.product],
    );
    expect(message).toMatch(/foreign key constraint "sale_lines_tenantId_saleId_fkey"/);
  });

  it('refuses an inventory balance on another tenant’s branch', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "inventory_balances" ("tenantId","branchId","productId","quantityScaled","updatedAt")
       VALUES ($1,$2,$3,1000, now())`,
      [A.tenant, B.branch, A.product],
    );
    expect(message).toMatch(/foreign key constraint "inventory_balances_tenantId_branchId_fkey"/);
  });

  it('refuses an inventory balance on another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "inventory_balances" ("tenantId","branchId","productId","quantityScaled","updatedAt")
       VALUES ($1,$2,$3,1000, now())`,
      [A.tenant, A.branch, B.product],
    );
    expect(message).toMatch(/foreign key constraint "inventory_balances_tenantId_productId_fkey"/);
  });

  it('refuses an inventory movement on another tenant’s branch', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "inventory_movements" ("id","tenantId","branchId","productId","kind","quantityScaled","occurredAt")
       VALUES ($1,$2,$3,$4,'adjustment',-1000, now())`,
      [SCRATCH.movement, A.tenant, B.branch, A.product],
    );
    expect(message).toMatch(/foreign key constraint "inventory_movements_tenantId_branchId_fkey"/);
  });

  it('refuses an inventory movement on another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "inventory_movements" ("id","tenantId","branchId","productId","kind","quantityScaled","occurredAt")
       VALUES ($1,$2,$3,$4,'adjustment',-1000, now())`,
      [SCRATCH.movement, A.tenant, A.branch, B.product],
    );
    expect(message).toMatch(/foreign key constraint "inventory_movements_tenantId_productId_fkey"/);
  });

  it('refuses a barcode attached to another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "product_barcodes" ("id","tenantId","productId","barcode")
       VALUES ($1,$2,$3,'6281000000009')`,
      [SCRATCH.barcode, A.tenant, B.product],
    );
    expect(message).toMatch(/foreign key constraint "product_barcodes_tenantId_productId_fkey"/);
  });

  it('refuses a price row attached to another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "product_prices" ("id","tenantId","productId","priceMinor","vatBasisPoints","effectiveFrom")
       VALUES ($1,$2,$3,1200,1500, now())`,
      [SCRATCH.price, A.tenant, B.product],
    );
    expect(message).toMatch(/foreign key constraint "product_prices_tenantId_productId_fkey"/);
  });

  it('refuses a terminal placed in another tenant’s branch', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
       VALUES ($1,$2,$3,'T9','صندوق', now())`,
      [SCRATCH.movement, A.tenant, B.branch],
    );
    expect(message).toMatch(/foreign key constraint "terminals_tenantId_branchId_fkey"/);
  });

  it('refuses a product filed under another tenant’s category', async () => {
    const message = await rejected(
      A.tenant,
      `INSERT INTO "products" ("id","tenantId","categoryId","sku","nameAr","priceMinor","vatBasisPoints","updatedAt")
       VALUES ($1,$2,$3,'SKU-X','منتج',1150,1500, now())`,
      [SCRATCH.price, A.tenant, B.category],
    );
    expect(message).toMatch(/foreign key constraint "products_tenantId_categoryId_fkey"/);
  });

  it('refuses an UPDATE that repoints a valid reference at another tenant', async () => {
    // The insert-time check is the obvious half. Without the same key on
    // UPDATE, a row could be created correctly and then walked across the
    // boundary afterwards.
    const message = await rejected(A.tenant, 'UPDATE "sales" SET "branchId" = $1 WHERE "id" = $2', [
      B.branch,
      A.sale,
    ]);
    expect(message).toMatch(/foreign key constraint "sales_tenantId_branchId_fkey"/);

    const unchanged = await asTenant(A.tenant, async () => {
      const result = await client.query<{ branchId: string }>(
        'SELECT "branchId" FROM "sales" WHERE "id" = $1',
        [A.sale],
      );
      return result.rows[0]?.branchId;
    });
    expect(unchanged).toBe(A.branch);
  });

  it('refuses an UPDATE that repoints a sale line at another tenant’s product', async () => {
    const message = await rejected(
      A.tenant,
      'UPDATE "sale_lines" SET "productId" = $1 WHERE "id" = $2',
      [B.product, A.saleLine],
    );
    expect(message).toMatch(/foreign key constraint "sale_lines_tenantId_productId_fkey"/);
  });

  it('carries a composite key on every reference between tenant-owned tables', async () => {
    // Read from the catalogue rather than the migration file: this is what the
    // server actually has, whatever any file says.
    const result = await client.query<{ conname: string; child: string; parent: string; cols: number }>(
      `SELECT c.conname,
              ch.relname AS child,
              pa.relname AS parent,
              array_length(c.conkey, 1) AS cols
         FROM pg_constraint c
         JOIN pg_class ch ON ch.oid = c.conrelid
         JOIN pg_class pa ON pa.oid = c.confrelid
         JOIN pg_namespace n ON n.oid = ch.relnamespace
        WHERE c.contype = 'f' AND n.nspname = 'public'`,
    );

    const global = ['tenants', 'permissions', 'global_catalog_items'];
    const betweenTenantTables = result.rows.filter((row) => !global.includes(row.parent));
    expect(betweenTenantTables.length).toBeGreaterThanOrEqual(30);

    for (const row of betweenTenantTables) {
      expect(row.cols, `${row.conname} references ${row.parent} by one column`).toBe(2);
    }
  });

  it('still lets a tenant be deleted whole, cascading through every table', async () => {
    // The refusing action is NO ACTION rather than RESTRICT precisely so this
    // works: the referencing rows disappear in the same statement, so the
    // check at end of statement finds nothing dangling.
    const scratch = '018f0000-0000-7000-8000-0000000000d0';
    const scratchBranch = '018f0000-0000-7000-8000-0000000000d1';
    await asTenant(scratch, async () => {
      await client.query(
        `INSERT INTO "tenants" ("id","name","slug","status","updatedAt")
         VALUES ($1,'Scratch','rls-live-scratch','active', now())`,
        [scratch],
      );
      await client.query(
        `INSERT INTO "branches" ("id","tenantId","code","nameAr","updatedAt")
         VALUES ($1,$2,'01','فرع', now())`,
        [scratchBranch, scratch],
      );
      await client.query(
        `INSERT INTO "terminals" ("id","tenantId","branchId","code","label","updatedAt")
         VALUES ($1,$2,$3,'T1','صندوق', now())`,
        ['018f0000-0000-7000-8000-0000000000d2', scratch, scratchBranch],
      );
    });

    const removed = await asTenant(scratch, async () => {
      const result = await client.query('DELETE FROM "tenants" WHERE "id" = $1', [scratch]);
      return result.rowCount;
    });
    expect(removed).toBe(1);
  });

  it('has no drift between the migration and the Prisma schema', async () => {
    // The composite keys are hand-written SQL. If Prisma's model of them ever
    // disagrees with the database, the next `prisma migrate dev` silently
    // proposes to undo them.
    const databaseDir = join(here, '../..');
    const output = execFileSync(
      'npx',
      ['--no-install', 'prisma', 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma'],
      { cwd: databaseDir, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' },
    );
    expect(output).toContain('No difference detected');
  }, 120_000);
});

describe.skipIf(url !== '')('tenant isolation, live', () => {
  it('is skipped without KORVI_TEST_DATABASE_URL', () => {
    // Stated rather than silent: a suite that quietly runs nothing looks
    // exactly like a suite that passed.
    expect(url).toBe('');
  });
});
EOF

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

say "Reference documents unchanged?"
[ "$(cksum < docs/design/KORVI-DESIGN-SYSTEM.md)" = "$REF_DESIGN_SUM" ] \
  || die "docs/design/KORVI-DESIGN-SYSTEM.md changed. Aborting."
[ "$(cksum < docs/governance/Korvi_POS_Master_Strategy_Document.txt)" = "$REF_STRAT_SUM" ] \
  || die "docs/governance/Korvi_POS_Master_Strategy_Document.txt changed. Aborting."
ok "reference documents intact"

say "Formatting the new sources"
npx prettier --write --log-level warn \
  'packages/database/src/**/*.ts' \
  'packages/domain/src/ports/**/*.ts' >/dev/null 2>&1 || true

say "Checking the migration is forward-only"
# A migration that drops a table takes a merchant's history with it. This is
# also asserted in the test suite; checking it here means a hand-edit to the
# SQL is caught before anything is run against a database.
if grep -Eqi '\bDROP[[:space:]]+(TABLE|DATABASE|SCHEMA|COLUMN)\b' "$MIGRATION_DIR/migration.sql"; then
  die "The migration contains a DROP. Refusing to ship a destructive migration."
fi
ok "no destructive statement in the migration"

if [ "$RUN_VERIFY" -eq 1 ]; then
  say "Running the full gate"
  npm run --silent verify
else
  warn "Skipping verification (--no-verify)."
fi

cat << 'SUMMARY'

===============================================================================
  Korvi POS — Strike 2A · SaaS database and tenant isolation applied
===============================================================================

  packages/database/prisma/schema.prisma
      31 models. Tenancy, identity, roles, terminals, settings, catalogue,
      barcodes, price history, inventory, customers, shifts, cash movements,
      sales, lines, discounts, tenders, invoices, tax breakdown, returns,
      refunds, idempotency, audit — plus the two global tables.

  packages/database/prisma/migrations/20260808120000_saas_foundation/
      Forward-only. Additive on the Phase 0 tables, creates the rest, and
      puts ENABLE + FORCE + one USING/WITH CHECK policy on all 29
      tenant-owned tables. Drops nothing.

      Tenant-consistent foreign keys. RLS protects a row; it does not
      protect a reference. A sale owned by tenant A, visible only to A,
      could still name a branch owned by B, because a key to branches(id)
      proves the branch exists and nothing else. Every tenant-owned parent
      therefore carries a unique key on (tenantId, id), and all 35
      references between tenant-owned tables point at that pair. The
      child's own tenantId appears on both sides, so PostgreSQL rejects a
      cross-tenant parent at INSERT and at UPDATE — no trigger, nothing the
      application can forget. References to the two global tables stay
      single-column: those rows have no tenant to be consistent with.

  packages/domain/src/ports/persistence.ts
      DTOs and repository ports. Money and quantity cross as strings, rates
      as the branded BasisPoints, timestamps as ISO 8601. No Prisma type
      appears. Every method takes a TenantScope first; the one exception is
      the global catalogue, which has no tenant.

  packages/database/src/repositories/
      Ten tenant-scoped adapters. Each runs inside withTenant(), so the
      RLS context is established on the transaction before any statement,
      and each also filters on tenantId explicitly. Neither alone is the
      boundary; together they mean a forgotten filter fails closed.

  packages/database/src/__tests__/rls-live.test.ts
      Live RLS, opt-in. `npm test` skips it and says so. To run it, apply
      both migrations to a throwaway database and connect as the
      application role — NOT a superuser, which bypasses RLS and would make
      every assertion pass for the wrong reason:

        createdb korvi_pos_test
        psql -d korvi_pos_test -f packages/database/prisma/migrations/00000000000000_rls_foundation/migration.sql
        psql -d korvi_pos_test -f packages/database/prisma/migrations/20260808120000_saas_foundation/migration.sql
        KORVI_TEST_DATABASE_URL=postgresql://korvi@localhost:5432/korvi_pos_test \
          npx vitest run packages/database/src/__tests__/rls-live.test.ts

      It asserts what the structural tests cannot see: that the server
      returns nothing for another tenant's row asked for by primary key,
      refuses an INSERT naming another tenant, refuses an UPDATE that
      reassigns a visible row, shows an empty database when no context is
      set, refuses every cross-tenant reference (branch, terminal, shift,
      user, customer, sale, product, category), refuses an UPDATE that
      repoints a valid reference at another tenant, still allows a whole
      tenant to be deleted, and reports no drift between this migration and
      the Prisma schema.

  Not touched: printing, ZATCA, UI, API, authentication.
  Nothing was committed, pushed, reset or cleaned.

===============================================================================
SUMMARY

ok "Done."
