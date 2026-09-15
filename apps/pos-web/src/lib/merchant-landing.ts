import type { Principal } from './api-types';

/**
 * Pick the merchant surface from server-derived effective permissions.
 *
 * Roles are labels and the browser is never an authority. The server already
 * resolves the effective permission set for the authenticated session; this
 * helper uses that set only to choose a landing experience. Every API call on
 * either surface continues to enforce the same permissions server-side.
 *
 * The list contains capabilities that the default cashier does not hold and
 * that belong to operating or administering the merchant rather than merely
 * serving a customer at a till. A custom role with any of these capabilities
 * therefore lands in Merchant Control too, which is safer and more useful than
 * trusting a role name that a tenant may customise around.
 */
const MERCHANT_CONTROL_PERMISSIONS = new Set([
  'product.write',
  'inventory.adjust',
  'inventory.transfer',
  'inventory.cost.read',
  'inventory.cost.manage',
  'purchasing.read',
  'purchasing.manage',
  'purchasing.receive',
  'sale.discount',
  'sale.refund',
  'sale.void',
  'shift.cash-movement',
  'report.read',
  'settings.manage',
  'users.manage',
  'zatca.manage',
]);

export type MerchantLandingPath = '/cashier' | '/control';

export function prefersMerchantControl(principal: Principal): boolean {
  return principal.permissions.some((permission) => MERCHANT_CONTROL_PERMISSIONS.has(permission));
}

export function merchantLandingPath(principal: Principal): MerchantLandingPath {
  return prefersMerchantControl(principal) ? '/control' : '/cashier';
}
