import { createHash } from 'node:crypto';
import {
  canonicalPurchaseOrderForm,
  canonicalPurchaseReceiptForm,
  canonicalSupplierCreateForm,
  canonicalSupplierUpdateForm,
} from '@korvi/domain';
import type {
  PurchaseOrderRequest,
  PurchaseReceiptRequest,
  SupplierCreateRequest,
  SupplierUpdateRequest,
} from '@korvi/domain';

/**
 * The purchasing request fingerprint, hashed here and canonicalized in the
 * domain.
 *
 * Exactly the split Strike 5A uses for stock, and for the same reason: what
 * counts as "the same intent" is a domain rule, written and tested there;
 * taking a SHA-256 of it needs `node:crypto` and therefore cannot be (ADR-0001).
 * The digest adds nothing to the decision — it only makes the answer a
 * fixed-width column value.
 *
 * The actor is bound in, for the reason ADR-0017 gives for drawer movements:
 * an operation id is a client-chosen string, and without the actor a second
 * user replaying a colleague's id would be handed that colleague's committed
 * document — a purchase order they never placed, or a delivery they never
 * signed for.
 *
 * Nothing the *server* derives is in here — not the document id, not the
 * resulting PO status, not the balance or revision a receipt will produce —
 * because those are consequences of the request rather than part of it, and
 * including one would make a lawful retry hash differently.
 */

function digest(form: readonly unknown[], actorUserId: string): string {
  return createHash('sha256')
    .update(JSON.stringify([actorUserId, ...form]), 'utf8')
    .digest('base64url');
}

export function fingerprintSupplierCreate(
  request: SupplierCreateRequest,
  actorUserId: string,
): string {
  return digest(canonicalSupplierCreateForm(request), actorUserId);
}

export function fingerprintSupplierUpdate(
  request: SupplierUpdateRequest,
  actorUserId: string,
): string {
  return digest(canonicalSupplierUpdateForm(request), actorUserId);
}

export function fingerprintPurchaseOrder(
  request: PurchaseOrderRequest,
  actorUserId: string,
): string {
  return digest(canonicalPurchaseOrderForm(request), actorUserId);
}

export function fingerprintPurchaseReceipt(
  request: PurchaseReceiptRequest,
  actorUserId: string,
): string {
  return digest(canonicalPurchaseReceiptForm(request), actorUserId);
}
