/**
 * The till this browser was last used as.
 *
 * sessionStorage, and only ever a terminal id. It is not a secret and not a
 * credential: a terminal id proves nothing on its own, the server re-checks it
 * against the session's branch on every request, and remembering it saves a
 * cashier one tap per shift.
 *
 * No token, no session, no principal is ever written here. The session lives in
 * an HttpOnly cookie precisely so that JavaScript cannot reach it, and copying
 * anything from it into storage would undo that in one line.
 */

const TERMINAL_KEY = 'korvi.pos.terminalId';

/** Storage is absent during server rendering and can throw in private modes. */
function storage(): Storage | null {
  try {
    return typeof globalThis.sessionStorage === 'undefined' ? null : globalThis.sessionStorage;
  } catch {
    return null;
  }
}

export function rememberedTerminalId(): string | null {
  try {
    return storage()?.getItem(TERMINAL_KEY) ?? null;
  } catch {
    return null;
  }
}

export function rememberTerminalId(terminalId: string): void {
  try {
    storage()?.setItem(TERMINAL_KEY, terminalId);
  } catch {
    // A till that cannot remember its number still sells. Nothing to report.
  }
}

export function forgetTerminalId(): void {
  try {
    storage()?.removeItem(TERMINAL_KEY);
  } catch {
    // As above.
  }
}
