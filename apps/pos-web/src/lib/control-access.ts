import type { Principal } from './api-types';

/**
 * Merchant Control is a separate product surface. The cashier may expose a
 * host-supplied link to it only when the server-derived effective permissions
 * include at least one Control section. This helper chooses presentation only;
 * every Control API remains server-authorized independently.
 */
const CONTROL_CENTRE_PERMISSIONS = new Set<Principal['permissions'][number]>([
  'report.read',
  'product.read',
  'inventory.read',
  'purchasing.read',
  'customer.read',
  'settings.manage',
  'users.manage',
  'zatca.manage',
]);

export function canOpenControlCentre(permissions: readonly string[]): boolean {
  return permissions.some((permission) => CONTROL_CENTRE_PERMISSIONS.has(permission));
}
