export function ownsAbortController(
  active: AbortController | null,
  request: AbortController,
): boolean {
  return active === request && !request.signal.aborted;
}
