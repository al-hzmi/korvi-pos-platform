export { createPrismaClient } from './client.js';
export type { PrismaClient } from './client.js';

export {
  withTenant,
  withControlPlane,
  withoutTenant,
  withLoginSlug,
  normalizeTenantSlug,
} from './tenant-context.js';
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
  CostBootstrapRefusedError,
  PurchasingRefusedError,
} from './errors.js';
export type {
  TenantProvisioningRefusal,
  TenantLifecycleRefusal,
  MerchantAdminRefusal,
  PlanEntitlementRefusal,
  OwnerBootstrapRefusal,
  StockOperationRefusal,
  CostBootstrapRefusal,
  PurchasingRefusal,
} from './errors.js';

export { createTenantRepository } from './repositories/tenant-repository.js';
export { createBranchRepository } from './repositories/branch-repository.js';
export { createDashboardRepository } from './repositories/dashboard-repository.js';
export { createTerminalRepository } from './repositories/terminal-repository.js';
export { createRestaurantFloorRepository } from './repositories/restaurant-floor-repository.js';
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
export {
  MAX_MERCHANT_SALES_PAGE,
  listMerchantSales,
  readMerchantSale,
} from './sales/read-model.js';
export type {
  MerchantSaleStatus,
  MerchantSalesQuery,
  MerchantSaleSummary,
  MerchantSalesPage,
  MerchantSaleDetail,
} from './sales/read-model.js';
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

// SaaS platform control-plane reads. Tenant discovery uses the dedicated
// SELECT-only control-plane RLS policy; every child-table detail read re-enters
// the ordinary tenant context instead of widening RLS installation-wide.
export {
  MAX_PLATFORM_TENANT_PAGE,
  MAX_PLATFORM_AUDIT_PAGE,
  listPlatformTenants,
  readPlatformTenant,
  readPlatformTenantDetail,
  listPlatformTenantAudit,
} from './control-plane/tenant-read.js';
export type {
  PlatformTenantListQuery,
  PlatformTenantSummary,
  PlatformTenantPage,
  PlatformOwnerSummary,
  PlatformTenantOperations,
  PlatformTenantDetail,
  PlatformAuditEntry,
  PlatformAuditPage,
} from './control-plane/tenant-read.js';
export {
  MAX_PLATFORM_SUPPORT_NOTE_LENGTH,
  MAX_PLATFORM_SUPPORT_NOTE_PAGE,
  PlatformSupportNoteRefusedError,
  listPlatformSupportNotes,
  createPlatformSupportNote,
} from './control-plane/support-notes.js';
export type {
  PlatformSupportNoteRefusal,
  PlatformSupportNote,
  PlatformSupportNotePage,
  PlatformSupportNoteCreateRequest,
  PlatformSupportNoteCreateResult,
} from './control-plane/support-notes.js';

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

// Merchant customer authority. Reads and writes remain tenant-scoped; mutation
// identity and actor authority are server-derived and every successful change
// records its result and audit evidence in the same transaction.
export {
  MAX_CUSTOMER_PAGE,
  CustomerAdminRefusedError,
  listMerchantCustomers,
  readMerchantCustomer,
  createMerchantCustomer,
  updateMerchantCustomer,
} from './administration/customers.js';
export type {
  CustomerAdminRefusal,
  CustomerActor,
  AdminCustomer,
  CustomerListQuery,
  CustomerPage,
  CustomerSaleLink,
  CustomerDetail,
  CustomerCreateRequest,
  CustomerUpdateRequest,
  CustomerMutationResult,
} from './administration/customers.js';

// Restaurant open-order authority. Rows are operational and non-fiscal; line
// price/tax facts are server-authored snapshots for later settlement.
export {
  RestaurantOrderRefusedError,
  listOpenRestaurantOrders,
  readRestaurantOrder,
  createRestaurantOrder,
  cancelRestaurantOrder,
  transferRestaurantOrderTable,
  replaceRestaurantOrderLines,
} from './restaurant/orders.js';
export type {
  RestaurantOrderRefusal,
  RestaurantOrderActor,
  RestaurantOrderCreateLine,
  RestaurantOrderCreateRequest,
  RestaurantOrderCancelRequest,
  RestaurantOrderTransferTableRequest,
  RestaurantOrderRetainedLine,
  RestaurantOrderNewLine,
  RestaurantOrderReplaceLinesRequest,
  RestaurantOrderLine,
  RestaurantOrderSummary,
  RestaurantOrderDetail,
  RestaurantOrderMutationResult,
} from './restaurant/orders.js';

// Category bootstrap. Tenant-scoped catalogue authority used by onboarding/migration.
export {
  CategoryBootstrapRefusedError,
  ensureCategory,
} from './administration/category-bootstrap.js';
export type {
  CategoryBootstrapRefusal,
  CategoryBootstrapActor,
  AdminCategoryBootstrap,
  EnsureCategoryResult,
} from './administration/category-bootstrap.js';

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

// Customer Migration Engine — Product M1 orchestration. File parsing/mapping
// stays in @korvi/domain/API; committed catalogue truth reuses the existing
// product bootstrap writer rather than creating a second product authority.
export {
  ProductImportRefusedError,
  createProductImportJob,
  readProductImportJob,
  readProductImportRows,
  dryRunProductImport,
  commitProductImport,
} from './migration/product-import.js';
export type {
  ProductImportRefusal,
  ProductImportActor,
  CreateProductImportJobRequest,
  ProductImportRowResult,
  ProductImportSummary,
  ProductImportRowPage,
} from './migration/product-import.js';

// Customer Migration Engine — Category M2 orchestration. Uses the same
// tenant-scoped migration job/row ledger as Product M1 and commits only through
// the established category bootstrap authority.
export {
  CategoryImportRefusedError,
  createCategoryImportJob,
  readCategoryImportJob,
  readCategoryImportRows,
  dryRunCategoryImport,
  commitCategoryImport,
} from './migration/category-import.js';
export type {
  CategoryImportRefusal,
  CategoryImportActor,
  CreateCategoryImportJobRequest,
  CategoryImportRowResult,
  CategoryImportSummary,
  CategoryImportRowPage,
} from './migration/category-import.js';

// Customer Migration Engine — M3 baseline + M6 explicit customer conflict strategy.
// Default remains reject. M6 may update only by the deterministic tenant-scoped
// phone business key and still reuses the authoritative customer writer.
export {
  CustomerImportRefusedError,
  createCustomerImportJob,
  readCustomerImportJob,
  readCustomerImportRows,
  dryRunCustomerImport,
  commitCustomerImport,
} from './migration/customer-import.js';
export type {
  CustomerImportConflictPolicy,
  CustomerImportRefusal,
  CustomerImportActor,
  CreateCustomerImportJobRequest,
  CustomerImportRowResult,
  CustomerImportSummary,
  CustomerImportRowPage,
} from './migration/customer-import.js';

// Customer Migration Engine — Supplier M4 orchestration. Supplier import uses
// the real purchasing supplier authority and deliberately carries only the
// currently supported create field: name.
export {
  SupplierImportRefusedError,
  createSupplierImportJob,
  readSupplierImportJob,
  readSupplierImportRows,
  dryRunSupplierImport,
  commitSupplierImport,
} from './migration/supplier-import.js';
export type {
  SupplierImportRefusal,
  SupplierImportActor,
  CreateSupplierImportJobRequest,
  SupplierImportRowResult,
  SupplierImportSummary,
  SupplierImportRowPage,
} from './migration/supplier-import.js';

// Customer Migration Engine — M5 opening inventory orchestration. Source files
// carry business keys only; commit derives tenant-scoped branch/product identity
// and posts explicit causal opening-stock movements with UNKNOWN cost.
export {
  OpeningInventoryImportRefusedError,
  createOpeningInventoryImportJob,
  readOpeningInventoryImportJob,
  readOpeningInventoryImportRows,
  dryRunOpeningInventoryImport,
  commitOpeningInventoryImport,
} from './migration/opening-inventory.js';
export type {
  OpeningInventoryImportRefusal,
  OpeningInventoryImportActor,
  CreateOpeningInventoryImportJobRequest,
  OpeningInventoryImportRowResult,
  OpeningInventoryImportSummary,
  OpeningInventoryImportRowPage,
} from './migration/opening-inventory.js';

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

// Prospective costing bootstrap (Strike 5C / ADR-0025). It values only the
// currently unknown positive quantity derived under stock + cost row locks,
// after matching the frozen read observations. It never changes stock
// quantity/revision or rewrites historical movement evidence.
export { recordInventoryCostBootstrap } from './costing/bootstrap.js';
export type { CostBootstrapActor, InventoryCostBootstrapResult } from './costing/bootstrap.js';
export { listCostBalancePage, MAX_COST_BALANCE_PAGE } from './costing/balances.js';
export type { CostBalancePage, CostBalancePageRow } from './costing/balances.js';

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
export { listPurchasingProductPage, MAX_PURCHASING_PRODUCT_PAGE } from './purchasing/catalog.js';
export type { PurchasingProduct, PurchasingProductPage } from './purchasing/catalog.js';
// ZATCA Compliance-CSID durable uncertainty boundary (Gate 39).
export { createZatcaCsidProvisioningRepository } from './zatca/csid-provisioning-repository.js';
export { createZatcaFatooraCredentialRepository } from './zatca/fatoora-credential-repository.js';
export type {
  ZatcaFatooraCiphertextRecord,
  ZatcaFatooraCredentialRepository,
} from './zatca/fatoora-credential-repository.js';
export { createZatcaInvoiceSubmissionRepository } from './zatca/invoice-submission-repository.js';
