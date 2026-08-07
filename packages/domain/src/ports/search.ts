/**
 * Liquid Search boundary — declared in Phase 0, implemented later.
 *
 * The target is sub-50ms prefix lookup against the local store while the
 * cashier is still typing, tolerant of the transpositions a hurried barcode
 * entry produces.
 *
 * `codeReverse` is the index that makes it work: the reversed SKU or barcode
 * stored alongside the forward one, so a suffix query becomes a prefix query
 * and can use the same ordered index. A cashier who reads the last four digits
 * off a label is doing a suffix search, and a plain prefix index cannot serve
 * it without a full scan.
 *
 * Phase 0 ships the port only — no implementation, so nothing depends on a
 * shape we have not yet measured against a real catalogue.
 */
import type { TenantScope } from './persistence.js';

export interface SearchHit {
  readonly id: string;
  readonly score: number;
}

export interface SearchQuery {
  readonly term: string;
  readonly limit: number;
}

export interface LiquidSearchPort {
  search(scope: TenantScope, query: SearchQuery): Promise<readonly SearchHit[]>;
}

/** Build the reversed form used by the codeReverse index. */
export function codeReverse(code: string): string {
  return [...code].reverse().join('');
}
