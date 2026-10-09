/**
 * Bind a browser-visible default to a draft as soon as the operator starts
 * entering decision data. Once bound, refreshes must never substitute another
 * entity silently; a missing bound id remains stale and must fail closed.
 */
export function bindVisibleSelectionId(currentId: string, visibleId: string | undefined): string {
  return currentId === '' ? (visibleId ?? '') : currentId;
}
