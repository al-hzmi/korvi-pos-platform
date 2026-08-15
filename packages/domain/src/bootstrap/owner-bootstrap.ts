import { DomainError } from '../errors.js';

/**
 * The vocabulary of establishing a merchant's very first Owner.
 *
 * Provisioning creates a tenant, its settings, its roles and an audit row, and
 * deliberately creates no merchant user and no credential (ADR-0018). A
 * platform operator is not a merchant user, and inventing one inside the
 * merchant's own data to make onboarding reachable would put an operator into
 * that merchant's user list. So there is a gap between "the tenant exists" and
 * "somebody can sign in", and this module is the vocabulary of the one bridge
 * across it (ADR-0021).
 *
 * Nothing here decides authority. What is here is what a capability may say,
 * how long it may say it for, and the single answer the public surface is
 * allowed to give when it will not honour one.
 */

export class OwnerBootstrapError extends DomainError {
  public override readonly name = 'OwnerBootstrapError';
}

/**
 * The version prefix, and why it is inside the signature rather than beside it.
 *
 * A token is `v1.<payload>.<signature>`, and the bytes that are signed include
 * the version. An attacker who could strip or rewrite the prefix could
 * otherwise present a v1 payload to a future v2 verifier — which is the
 * downgrade every versioned token format eventually meets.
 */
export const OWNER_BOOTSTRAP_CAPABILITY_VERSION = 'v1';

/**
 * Everything the capability asserts, and nothing else.
 *
 * Three claims. Not the email, not the display name, not the role, not the
 * operator who issued it: all of those live on the invitation row, which the
 * acceptance transaction reads *under its own lock* after the signature has
 * been verified. A claim in a token is a fact frozen at issue time; a column is
 * a fact as it stands now, and the second is the one that should decide what
 * account gets created.
 */
export interface OwnerBootstrapClaims {
  readonly invitationId: string;
  readonly tenantId: string;
  /** ISO 8601. Checked against the row's own expiry as well, never instead. */
  readonly expiresAt: string;
}

/**
 * A day, because a bootstrap invitation is an operational hand-off.
 *
 * Long enough that an operator can send it and a merchant can act on it in
 * their own working hours; short enough that a capability found in a mailbox
 * a month later is inert. There is no renewal in this strike — an expired
 * invitation is re-issued by the control plane under a new operation.
 */
export const OWNER_BOOTSTRAP_TTL_SECONDS = 24 * 60 * 60;

/** Bounded so a token cannot become an unbounded parse. */
export const MAX_OWNER_BOOTSTRAP_TOKEN = 1024;

/**
 * The one thing the public surface says when it will not honour a capability.
 *
 * Unknown invitation, wrong tenant, already consumed, expired, revoked, bad
 * signature, wrong version and a merchant that already has an administrator
 * all answer identically. Telling them apart would turn the public endpoint
 * into an oracle for which tenants exist, which invitations are outstanding
 * and which merchants have already been set up — and the person who benefits
 * from that distinction is never the invitee, who either has a working
 * capability or needs a new one either way.
 */
export const OWNER_BOOTSTRAP_REFUSAL = 'invalid-capability';

/**
 * One event name per act, never a generic one.
 *
 * `owner-bootstrap.invited` is written by the control plane inside the issuing
 * transaction; `owner-bootstrap.accepted` by the acceptance transaction. A
 * refused acceptance writes neither, so the trail names only what happened.
 */
export const OWNER_BOOTSTRAP_EVENTS = [
  'owner-bootstrap.invited',
  'owner-bootstrap.accepted',
] as const;

export type OwnerBootstrapEvent = (typeof OWNER_BOOTSTRAP_EVENTS)[number];

/**
 * The role the first Owner is given, resolved by key rather than by id.
 *
 * The client cannot name a role and neither can the control plane: the
 * acceptance transaction looks this key up among the tenant's own system roles,
 * which provisioning installed. A `roleId` parameter anywhere on this path
 * would be a way to bootstrap somebody into whichever role happened to be
 * convenient.
 */
export const OWNER_BOOTSTRAP_ROLE_KEY = 'owner';

/**
 * Whether an invitation may still be honoured, as a pure question.
 *
 * Both halves matter and neither is sufficient. The capability carries an
 * expiry so a verifier can reject a stale token without touching the database;
 * the row carries one so a token that was signed with a longer life than the
 * record allows cannot outlive it. The acceptance path checks the row's, and
 * this is the shape of that check.
 */
export function isInvitationOpen(
  invitation: { readonly expiresAt: string; readonly consumedAt: string | null },
  now: Date,
): boolean {
  if (invitation.consumedAt !== null) return false;
  return new Date(invitation.expiresAt).getTime() > now.getTime();
}

/** The expiry a freshly issued invitation carries. */
export function bootstrapExpiryFrom(issuedAt: Date): Date {
  return new Date(issuedAt.getTime() + OWNER_BOOTSTRAP_TTL_SECONDS * 1000);
}
