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
} from './errors.js';
export type { TenantProvisioningRefusal, TenantLifecycleRefusal } from './errors.js';

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
