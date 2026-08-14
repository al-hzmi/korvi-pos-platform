import { DomainError } from '../errors.js';
import type { Permission } from '../rbac/permissions.js';

/**
 * The rules a merchant administrator's own changes must obey.
 *
 * Pure, because every one of them has to hold identically in an HTTP handler,
 * in a repository transaction and in whatever calls them next. A rule that
 * lives only in a Fastify handler is a rule the next caller does not get.
 *
 * Nothing here decides *who may* administer anything — that is the permission
 * check, and it happens on the server against the session's own permissions.
 * What is here is what an administrative change may say and what it may not
 * leave behind (ADR-0019).
 */

export class MerchantAdminError extends DomainError {
  public override readonly name = 'MerchantAdminError';
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * A branch or till code is typed on a keypad and printed on a receipt.
 *
 * Short, because it is read aloud across a shop floor; upper-cased and
 * NFKC-normalised, because "٠١" and "01" are the same code to the person who
 * typed them and two different rows to a unique index.
 */
export const MAX_ADMIN_CODE = 16;
export const MAX_ADMIN_NAME = 120;
export const MAX_RECEIPT_LINE = 200;
export const MAX_ADMIN_LIST_PAGE = 100;

/**
 * A hard ceiling on the assignable-role set, and why it is a ceiling rather
 * than a page.
 *
 * Roles are per tenant, but custom-role CRUD is explicitly not built (ADR-0019)
 * — a tenant's roles are the four Korvi provisions, and the only way to acquire
 * more is a migration or a future strike that will bring its own contract.
 * Paginating a set of four would be complexity with no reader.
 *
 * What must not happen is an unbounded `findMany` sitting in the code waiting
 * for that future strike to make it a production query, so the bound is real,
 * enforced by the query, and tested against a tenant carrying more roles than
 * the ceiling.
 */
export const MAX_ASSIGNABLE_ROLES = 25;

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

/**
 * Arabic-Indic and Eastern Arabic-Indic digits, folded to ASCII.
 *
 * NFKC does not do this and should not: ٠ and 0 are different characters, not
 * a compatibility form of one another. But Korvi is Arabic-first and this is a
 * Saudi keyboard, so an owner typing branch ٠١ and a cashier typing branch 01
 * mean the same shop, and a unique index that disagrees would let them create
 * it twice.
 *
 * Done explicitly, in one direction, so the mapping is visible rather than a
 * property of whatever Unicode does next.
 */
const ARABIC_DIGITS = /[\u0660-\u0669\u06f0-\u06f9]/g;

function foldDigits(input: string): string {
  return input.replace(ARABIC_DIGITS, (digit) => {
    const code = digit.codePointAt(0) ?? 0;
    const base = code >= 0x06f0 ? 0x06f0 : 0x0660;
    return String.fromCharCode(0x30 + (code - base));
  });
}

export function normalizeAdminCode(input: string): string {
  const candidate = foldDigits(input.normalize('NFKC').trim()).toUpperCase();
  if (!CODE_PATTERN.test(candidate)) {
    throw new MerchantAdminError(
      'A branch or till code is 1 to 16 characters of A-Z, 0-9 and hyphen, starting with a letter or digit.',
    );
  }
  return candidate;
}

/**
 * A human-facing name, trimmed and bounded, never truncated.
 *
 * Truncating a merchant's own name is a silent corruption of the thing they
 * typed; refusing it is a message they can act on.
 */
export function normalizeAdminName(input: string, max: number = MAX_ADMIN_NAME): string {
  const candidate = input.normalize('NFKC').trim();
  if (candidate === '') throw new MerchantAdminError('That name is empty.');
  if (candidate.length > max) {
    throw new MerchantAdminError(`That name is longer than ${max} characters.`);
  }
  return candidate;
}

/**
 * An optional free-text line, where the empty string means "clear it".
 *
 * Distinguished from `undefined`, which means "leave it alone". A patch that
 * could not express the difference would make an unset field unclearable.
 */
export function normalizeOptionalLine(
  input: string | null,
  max: number = MAX_RECEIPT_LINE,
): string | null {
  if (input === null) return null;
  const candidate = input.normalize('NFKC').trim();
  if (candidate === '') return null;
  if (candidate.length > max) {
    throw new MerchantAdminError(`That text is longer than ${max} characters.`);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Surviving administrative authority
// ---------------------------------------------------------------------------

/**
 * What "administrator" means here, and why it is not a role name.
 *
 * A tenant is manageable while at least one person can still change who may do
 * what. In Korvi's model that capability is exactly one named permission —
 * `users.manage` — and it is reachable through any role that grants it,
 * including one a merchant defines later. Keying the invariant on the role
 * called "owner" would be wrong in both directions: a merchant who renames
 * their roles would lose the protection, and a merchant whose owner role had
 * been stripped of the permission would keep a protection that protects
 * nothing.
 */
export const ADMINISTRATIVE_AUTHORITY: Permission = 'users.manage';

/**
 * One person who might still be able to administer the tenant.
 *
 * Three facts, because all three are required and any one of them can be
 * removed by a single administrative request: the account can sign in, the
 * membership admits them to this tenant, and something they hold grants the
 * authority. A candidate is only *viable* when all three hold.
 */
export interface AdministrativeCandidate {
  readonly userId: string;
  readonly userActive: boolean;
  readonly membershipActive: boolean;
}

export function isViableAdministrator(candidate: AdministrativeCandidate): boolean {
  return candidate.userActive && candidate.membershipActive;
}

/** Distinct users, because one person holding two granting roles is one person. */
export function countViableAdministrators(candidates: readonly AdministrativeCandidate[]): number {
  const viable = new Set<string>();
  for (const candidate of candidates) {
    if (isViableAdministrator(candidate)) viable.add(candidate.userId);
  }
  return viable.size;
}

/**
 * Refuse a change that would leave nobody able to undo it.
 *
 * Called with the state the transaction has *already written*, before it
 * commits, so it measures the real outcome rather than predicting one. That is
 * the only version of this check that is correct under concurrency: two
 * requests each removing a different administrator both look harmless in
 * isolation, and only the second one's post-state shows the tenant is locked
 * out.
 */
export function assertAdministrativeAuthorityRemains(
  candidates: readonly AdministrativeCandidate[],
): void {
  if (countViableAdministrators(candidates) === 0) {
    throw new MerchantAdminError(
      'That change would leave this merchant with nobody able to administer it.',
    );
  }
}

// ---------------------------------------------------------------------------
// Audit vocabulary
// ---------------------------------------------------------------------------

/**
 * One event name per administrative act, never a generic one.
 *
 * An audit trail whose rows all say "updated" is an audit trail nobody can
 * answer a question with.
 */
export const MERCHANT_ADMIN_EVENTS = [
  'tenant.settings.updated',
  'branch.created',
  'branch.updated',
  'branch.activated',
  'branch.deactivated',
  'terminal.created',
  'terminal.updated',
  'terminal.activated',
  'terminal.deactivated',
  'member.created',
  'member.updated',
  'member.user-activated',
  'member.user-deactivated',
  'member.membership-activated',
  'member.membership-deactivated',
  'member.role-assigned',
  'member.role-unassigned',
] as const;

export type MerchantAdminEvent = (typeof MERCHANT_ADMIN_EVENTS)[number];

export function activationEvent(
  entity: 'branch' | 'terminal',
  isActive: boolean,
): MerchantAdminEvent {
  if (entity === 'branch') return isActive ? 'branch.activated' : 'branch.deactivated';
  return isActive ? 'terminal.activated' : 'terminal.deactivated';
}
