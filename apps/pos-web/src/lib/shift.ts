import { describeFailure } from './failures';
import type { ApiClient, RequestOptions } from './api';
import type { ShiftSummary } from './api-types';
import type { Failure } from './failures';

/**
 * Whether this till has a drawer this cashier may sell through.
 *
 * A cash sale needs somewhere for the cash to go, and the server refuses one
 * without an open shift. Asking first turns that refusal into a screen the
 * cashier can act on instead of an error after a basket has been built.
 *
 * `foreign` is the case worth naming. One drawer belongs to one cashier: the
 * sale transaction re-reads the shift under its own row lock and refuses a
 * sale whose cashier is not the shift's, so a till left open by the previous
 * shift would let a basket be built and then reject it at payment. Discovering
 * it here costs one read and saves a queue.
 */

export type ShiftState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'closed' }
  | { readonly kind: 'open'; readonly shift: ShiftSummary }
  | { readonly kind: 'foreign'; readonly shift: ShiftSummary }
  | { readonly kind: 'blocked'; readonly failure: Failure };

export const initialShiftState: ShiftState = { kind: 'loading' };

export const FOREIGN_SHIFT: Failure = {
  code: 'foreign_shift',
  message:
    'هذا الصندوق لديه وردية مفتوحة لكاشير آخر. اختر صندوقاً آخر أو اطلب إغلاق الوردية الحالية.',
  action: 'blocking',
};

/**
 * Which refusals mean the shift on screen is out of date.
 *
 * `shift-invalid` is the obvious one — the sale transaction re-read the shift
 * and did not like what it found. `no-open-shift` is the one that was missed:
 * a drawer closed under the till while a basket was being built, and a cashier
 * left staring at a checkout button that will never work is worse than one
 * sent back to open a shift.
 */
export function shiftNeedsRefresh(action: string | undefined): boolean {
  return action === 'refresh-shift' || action === 'open-shift';
}

/**
 * `userId` is the signed-in cashier, from the session — never from the shift.
 * Comparing the shift to itself would always agree.
 */
export async function loadShift(
  api: ApiClient,
  terminalId: string,
  userId: string,
  options?: RequestOptions,
): Promise<ShiftState> {
  try {
    const shift = await api.currentShift(terminalId, options);
    if (shift === null) return { kind: 'closed' };
    // No takeover, and none is invented here: the server would refuse the sale
    // and there is no Korvi rule that permits a shared drawer.
    if (shift.userId !== userId) return { kind: 'foreign', shift };
    return { kind: 'open', shift };
  } catch (error) {
    return { kind: 'blocked', failure: describeFailure(error) };
  }
}
