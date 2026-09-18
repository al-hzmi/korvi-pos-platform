import type { RestaurantOrderType } from '@korvi/domain';

/**
 * Stable counter-service order identity.
 *
 * It is deliberately derived from the checkout operation id instead of a new
 * sequence. The same financial intent therefore keeps the same preparation
 * number across retries, offline queueing and idempotent server replay.
 */
export function quickServiceOrderNumber(operationId: string, terminalCode: string): string {
  const compact = operationId.replaceAll('-', '').toUpperCase();
  const suffix = compact.slice(-8);
  const terminal = terminalCode.trim().replace(/\s+/g, '-').slice(0, 12);
  return `${terminal === '' ? 'POS' : terminal}-${suffix}`;
}


export function restaurantOrderTypeLabelAr(orderType: RestaurantOrderType): string {
  switch (orderType) {
    case 'dine-in':
      return 'محلي';
    case 'takeaway':
      return 'سفري';
    case 'delivery':
      return 'توصيل';
  }
}
