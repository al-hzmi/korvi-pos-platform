import { createHash } from 'node:crypto';
import {
  canonicalAdjustmentForm,
  canonicalCostBootstrapForm,
  canonicalCountForm,
  canonicalTransferForm,
} from '@korvi/domain';
import type {
  AdjustmentRequest,
  CostBootstrapRequest,
  CountRequest,
  TransferRequest,
} from '@korvi/domain';

/**
 * The request fingerprint, hashed here and canonicalized in the domain.
 *
 * The split follows ADR-0001: deciding what counts as "the same intent" is a
 * domain rule and is written and tested there; taking a SHA-256 of it needs
 * `node:crypto` and therefore cannot be. The digest adds nothing to the
 * decision — it only makes the answer a fixed-width column value.
 *
 * The actor is bound in, for the reason ADR-0017 gives for drawer movements:
 * an operation id is a client-chosen string, and without the actor a second
 * user replaying a colleague's id would be handed that colleague's committed
 * document instead of being told the ids collide.
 *
 * Nothing the *server* derives is in here — not the resulting balance, not the
 * revision the count will produce, not the document id — because those are
 * consequences of the request rather than part of it, and including one would
 * make a lawful retry hash differently.
 */

function digest(form: readonly unknown[], actorUserId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([actorUserId, ...form]), 'utf8')
    .digest('base64url');
}

export function fingerprintAdjustment(request: AdjustmentRequest, actorUserId: string): string {
  return digest(canonicalAdjustmentForm(request), actorUserId);
}

export function fingerprintCount(request: CountRequest, actorUserId: string): string {
  return digest(canonicalCountForm(request), actorUserId);
}

export function fingerprintTransfer(request: TransferRequest, actorUserId: string): string {
  return digest(canonicalTransferForm(request), actorUserId);
}
export function fingerprintCostBootstrap(
  request: CostBootstrapRequest,
  actorUserId: string,
): string {
  return digest(canonicalCostBootstrapForm(request), actorUserId);
}
