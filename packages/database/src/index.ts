export { createPrismaClient } from './client.js';
export type { PrismaClient } from './client.js';

export { withTenant, withoutTenant, withLoginSlug, normalizeTenantSlug } from './tenant-context.js';
export type { TransactionClient } from './tenant-context.js';

export {
  DatabaseError,
  TenantContextError,
  InsufficientStockError,
  OperationAlreadyRecordedError,
  ShiftUnusableError,
  ShiftOpenRefusedError,
  ReturnNotAllowedError,
  DrawerRefusedError,
  TenantProvisioningError,
  TenantLifecycleRefusedError,
  MerchantAdminRefusedError,
  PlanEntitlementRefusedError,
  OwnerBootstrapRefusedError,
  StockOperationRefusedError,
  PurchasingRefusedError,
} from './errors.js';
export type {
  TenantProvisioningRefusal,
  TenantLifecycleRefusal,
  MerchantAdminRefusal,
  PlanEntitlementRefusal,
  OwnerBootstrapRefusal,
  StockOperationRefusal,
  PurchasingRefusal,
} from './errors.js';

export { createTenantRepository } from './repositories/tenant-repository.js';
export { createBranchRepository } from './repositories/branch-repository.js';
export { createDashboardRepository } from './repositories/dashboard-repository.js';
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
export { createReturnRepository } from './repositories/return-repository.js';
export { createIdempotencyRepository } from './repositories/idempotency-repository.js';
export { createAuditRepository } from './repositories/audit-repository.js';
export { createAuthRepository } from './repositories/auth-repository.js';
export {
  PERMISSION_CATALOGUE,
  DEFAULT_ROLES,
  provisionPermissionCatalogue,
  provisionTenantRbac,
  assignRole,
} from './provisioning/rbac.js';
export type { ProvisionedRole } from './provisioning/rbac.js';
// `provisionTenantRbacWithin` is deliberately not re-exported. It takes a raw
// tenant string and an open transaction, which is safe only because the tenant
// provisioner calls it from inside withTenant. On the public surface it would
// be a way to write roles into an arbitrary tenant — the same reason
// `applyMovementWithin` stays internal.
export {
  TENANT_LIFECYCLE_SCOPE,
  provisionTenant,
  activateTenant,
  suspendTenant,
  reactivateTenant,
} from './provisioning/tenant.js';
export type {
  TenantProvisioningRequest,
  ProvisionedTenant,
  TenantLifecycleRequest,
  TenantSuspensionRequest,
  TenantLifecycleResult,
} from './provisioning/tenant.js';
export { fingerprintProvisioning, fingerprintLifecycle } from './provisioning/fingerprint.js';
export type { ProvisioningIntent, LifecycleIntent } from './provisioning/fingerprint.js';

// Merchant administration (Strike 4B-1). Tenant-scoped, session-derived, and
// deliberately separate from the control-plane functions above: nothing here
// can provision, activate, suspend or reactivate a tenant.
export {
  updateTenantSettings,
  listBranches,
  createBranch,
  updateBranch,
  setBranchActive,
  listTerminals,
  createTerminal,
  updateTerminal,
  setTerminalActive,
  listMembers,
  createMember,
  updateMember,
  setMemberUserActive,
  setMemberMembershipActive,
  listAssignableRoles,
  assignRoleToMember,
  removeRoleFromMember,
} from './administration/merchant-admin.js';
export type {
  AdminActor,
  AdminBranch,
  AdminMember,
  AdminPage,
  AdminRole,
  AdminTenantSettings,
  AdminTerminal,
  AccessChange,
  BranchPatch,
  MemberPatch,
  NewBranch,
  NewMember,
  NewTerminal,
  RoleAssignmentResult,
  TenantSettingsPatch,
  TerminalPatch,
} from './administration/merchant-admin.js';

// Product bootstrap (Strike 4D-4). Tenant-scoped merchant authority that creates
// catalogue truth only; no stock movement and no onboarding-complete flag.
export {
  ProductBootstrapRefusedError,
  createBootstrapProduct,
} from './administration/product-bootstrap.js';
export type {
  ProductBootstrapRefusal,
  ProductBootstrapActor,
  AdminProductBootstrap,
} from './administration/product-bootstrap.js';

// Commercial plan/entitlement control-plane foundation (Strike 4C).
// No merchant HTTP authority and no billing-provider semantics live here.
export {
  PLAN_ASSIGNMENT_EVENT,
  assignTenantPlan,
  readCommercialAccount,
  fingerprintCommercialPlanAssignment,
} from './commercial/plan-entitlements.js';
export type {
  CommercialPlanIntent,
  TenantPlanAssignmentRequest,
  TenantPlanAssignmentResult,
} from './commercial/plan-entitlements.js';

// Onboarding readiness (Strike 4D-1).
// Read-only and evidence-derived; there is deliberately no persisted
// "onboarding complete" flag.
export { readTenantOnboardingReadiness } from './onboarding/readiness.js';

// Initial owner bootstrap (Strike 4D-3). The issuing half is trusted control
// plane and takes a tenant id; the accepting half takes a signed capability and
// nothing else. `signOwnerBootstrapCapability` is not exported: minting a
// capability is the control plane's, and a caller that could sign one could
// bootstrap into any tenant (ADR-0021).
export {
  issueOwnerBootstrapInvitation,
  acceptOwnerBootstrap,
  fingerprintOwnerBootstrap,
} from './bootstrap/owner-bootstrap.js';
export type {
  OwnerBootstrapIntent,
  OwnerBootstrapIssueRequest,
  IssuedOwnerBootstrap,
  OwnerBootstrapAcceptance,
} from './bootstrap/owner-bootstrap.js';
export { verifyOwnerBootstrapCapability } from './bootstrap/capability.js';

// Merchant stock authority (Strike 5A). Each of these takes a server-derived
// actor and opens its own tenant-scoped transaction, so there is no variant on
// this surface that accepts a raw tenant or an open transaction — the same
// reason `applyMovementWithin` stays internal.
export {
  recordInventoryAdjustment,
  recordInventoryCount,
  recordInventoryTransfer,
} from './inventory/stock-ledger.js';
export type {
  StockActor,
  StockLineResult,
  AdjustmentResult,
  CountLineResult,
  CountResult,
  TransferLineResult,
  TransferResult,
} from './inventory/stock-ledger.js';
export { listBalancePage, MAX_BALANCE_PAGE } from './inventory/balances.js';
export type { BalancePage, BalancePageRow } from './inventory/balances.js';
export { listInventoryBranchPage, MAX_INVENTORY_BRANCH_PAGE } from './inventory/branches.js';
export type { InventoryBranch, InventoryBranchPage } from './inventory/branches.js';

// Prospective costing bootstrap (Strike 5C). It values only the currently
// unknown positive quantity derived under stock + cost row locks; it never
// changes stock quantity/revision or rewrites historical movement evidence.
export { recordInventoryCostBootstrap } from './costing/bootstrap.js';
export type { CostBootstrapActor, InventoryCostBootstrapResult } from './costing/bootstrap.js';

// Purchasing and receiving authority (Strike 5B). Same rule as above: every
// function here derives its tenant from a server-supplied actor and opens its
// own tenant-scoped transaction.
//
// `lockBranches`, `lockProducts`, `lockBalances`, `lockedOrThrow` and
// `claimOperation` are exported from `inventory/stock-ledger.js` for these
// modules to share, and are deliberately *not* re-exported here: each takes a
// raw tenant string and an open transaction, which is safe only inside
// `withTenant`.
export {
  createSupplier,
  updateSupplier,
  listSuppliers,
  getSupplier,
  MAX_SUPPLIER_PAGE,
} from './purchasing/suppliers.js';
export type {
  SupplierActor,
  SupplierRecord,
  SupplierResult,
  SupplierPage,
} from './purchasing/suppliers.js';
export {
  createPurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  MAX_PURCHASE_ORDER_PAGE,
} from './purchasing/purchase-orders.js';
export type {
  PurchasingActor,
  PurchaseOrderLineRecord,
  PurchaseOrderRecord,
  PurchaseOrderResult,
  PurchaseOrderSummary,
  PurchaseOrderPage,
} from './purchasing/purchase-orders.js';
export {
  recordPurchaseReceipt,
  listPurchaseReceipts,
  MAX_RECEIPT_PAGE,
} from './purchasing/receiving.js';
export type {
  ReceivingActor,
  PurchaseReceiptLineResult,
  PurchaseReceiptResult,
  PurchaseReceiptSummary,
} from './purchasing/receiving.js';
