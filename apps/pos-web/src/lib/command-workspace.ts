/**
 * A 401/403 response is a definitive server refusal, not an ambiguous commit.
 * The failed form remains locally blocked, but the control-centre workspace
 * must be released so the operator can leave the section or sign in again.
 * Editable validation failures are definitive for the same reason.
 */
export function commandFailureReleasesWorkspace(action: string): boolean {
  return action === 'edit-command' || action === 'permission' || action === 'reauthenticate';
}
