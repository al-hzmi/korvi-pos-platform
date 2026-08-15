import { createHash } from 'node:crypto';
import {
  OWNER_BOOTSTRAP_ROLE_KEY,
  assertNewPasswordAcceptable,
  bootstrapExpiryFrom,
  isInvitationOpen,
  newId,
  normalizeAdminName,
  normalizeControlPlaneActor,
  normalizeControlPlaneOperation,
  normalizeEmail,
} from '@korvi/domain';
import { Prisma } from '../../generated/client/client.js';
import { withTenant } from '../tenant-context.js';
import { DatabaseError, OwnerBootstrapRefusedError } from '../errors.js';
import { iso } from '../repositories/mapping.js';
import { viableAdministratorExists } from '../onboarding/viability.js';
import { signOwnerBootstrapCapability, verifyOwnerBootstrapCapability } from './capability.js';
import type { TransactionClient } from '../tenant-context.js';
import type { PrismaClient } from '../client.js';

/**
 * Establishing a merchant's very first Owner.
 *
 * Two entry points and two entirely different trust levels, which is the whole
 * shape of this module:
 *
 *   `issueOwnerBootstrapInvitation` is trusted control plane. It is not HTTP,
 *   it is not the merchant's, and it takes a `tenantId` because it is *inside*
 *   the boundary where naming a tenant is the operator's job.
 *
 *   `acceptOwnerBootstrap` is reachable by anybody with a token. It takes no
 *   tenant, no user, no role and no email. Everything it acts on is either a
 *   signed claim it has just verified or a column it reads under a lock.
 *
 * Neither touches tenant lifecycle. Creating an Owner does not activate,
 * suspend or reactivate anything, and it does not make a merchant ready to
 * trade — readiness is evidence-derived and stays that way (ADR-0018,
 * ADR-0021).
 */

// ---------------------------------------------------------------------------
// Issue — trusted control plane
// ---------------------------------------------------------------------------

export interface OwnerBootstrapIntent {
  readonly tenantId: string;
  readonly email: string;
  readonly displayName: string;
  readonly controlPlaneActorRef: string;
}

export interface OwnerBootstrapIssueRequest extends OwnerBootstrapIntent {
  readonly operationId: string;
}

export interface IssuedOwnerBootstrap {
  readonly invitationId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly expiresAt: string;
  /**
   * The capability, returned to the operator and stored nowhere.
   *
   * Re-derived on an idempotent replay from the row plus the signing key, so
   * a retry hands back the identical token without the token ever having been
   * a column.
   */
  readonly capability: string;
  /** False when this call replayed an earlier operation rather than issuing. */
  readonly created: boolean;
}

/**
 * The canonical intent, so a retry that changed its mind is not a retry.
 *
 * Binds the tenant, the bound address, the display name and the operator.
 * Expiry is deliberately absent: it is derived from the issue time, so
 * including it would make every retry a conflict. The row's own `expiresAt` is
 * what a replay returns, which is what "same logical invitation" means.
 */
export function fingerprintOwnerBootstrap(intent: OwnerBootstrapIntent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'owner-bootstrap.v1',
        intent.tenantId,
        intent.email,
        intent.displayName,
        intent.controlPlaneActorRef,
      ]),
      'utf8',
    )
    .digest('base64url');
}

const INVITATION_SELECT = {
  id: true,
  tenantId: true,
  operationId: true,
  requestHash: true,
  email: true,
  displayName: true,
  expiresAt: true,
  consumedAt: true,
} as const;

/**
 * Take the tenant row for the whole transaction.
 *
 * The same serialization point 4B-1 uses for authority-reducing changes, and
 * for the same reason: "does this merchant already have an administrator" and
 * "is there already an open invitation" are both questions whose answer two
 * concurrent transactions would otherwise each get right in isolation and
 * wrong together.
 */
async function lockTenant(tx: TransactionClient, tenant: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "tenants" WHERE "id" = ${tenant}::uuid FOR UPDATE`;
  if (rows.length !== 1) throw new OwnerBootstrapRefusedError('unknown-tenant');
}

/**
 * Has this merchant ever completed an initial owner bootstrap?
 *
 * The door is one-way. Once an acceptance has succeeded for a tenant, that
 * tenant's *initial* bootstrap is finished forever, and nothing that happens to
 * the resulting Owner afterwards reopens it: not deactivation, not a cancelled
 * membership, not a lost credential, not a stripped permission, not a corrupted
 * role. Each of those is a merchant that has lost its administrator, which is a
 * **recovery** problem — a different authority, a different threat model, and
 * explicitly outside this strike (ADR-0021).
 *
 * The distinction matters because the two questions look alike and are not.
 * "Does this merchant currently have a viable administrator" is about *now*, and
 * it is the right guard *before* a first bootstrap, so bootstrap cannot mint a
 * second authority beside an existing one. It is the wrong guard afterwards: it
 * goes false again whenever authority lapses, and a bootstrap path that reopens
 * on that condition is an unauthenticated Owner-recovery flow that nobody
 * designed, reachable by anyone holding an old capability.
 *
 * So closure is asked of monotonic evidence instead. `consumedAt` is written in
 * exactly one place — the consume step of a successful acceptance — and never by
 * expiry, never by issuing, never by a lifecycle change. A consumed invitation
 * is therefore a fact that can only be added to history, which is precisely what
 * a permanent gate needs and what current viability can never be.
 *
 * Note what this does *not* count: the invitation being accepted right now. It
 * is still unconsumed when this is asked, so an acceptance never closes the door
 * against itself; it closes it on its way out, by consuming.
 */
async function hasCompletedInitialOwnerBootstrap(
  tx: TransactionClient,
  tenant: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ present: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
        FROM "tenant_owner_bootstrap_invitations"
       WHERE "tenantId" = ${tenant}::uuid
         AND "consumedAt" IS NOT NULL
    ) AS "present"`;
  return rows[0]?.present === true;
}

/**
 * Does this merchant already have somebody who can sign in and run it?
 *
 * Exactly 4D readiness's meaning, from 4D readiness's own definition — the
 * shared fragment, not a paraphrase of it. That matters in both directions.
 * A bootstrap that closed on a *weaker* test than readiness would leave a
 * merchant readiness calls unadministrable with no way to bootstrap one; a
 * bootstrap that established less than readiness demands would report success
 * for an Owner who cannot finish onboarding.
 *
 * Deliberately not a role name, and deliberately not 4B-1's single
 * `users.manage` authority: 4D requires `settings.manage` *and* `users.manage`,
 * both held through some role, and somebody who can add staff but cannot
 * configure the shop is not what this question is asking about.
 */
async function hasViableAdministrator(tx: TransactionClient, tenant: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ present: boolean }[]>(
    Prisma.sql`SELECT ${viableAdministratorExists(Prisma.sql`${tenant}::uuid`)} AS "present"`,
  );
  return rows[0]?.present === true;
}

/**
 * Is *this* account, right now, a viable administrator of this merchant?
 *
 * The postcondition. Everything above establishes authority step by step —
 * user, membership, role grant — and each step is individually plausible while
 * the whole is broken: a system Owner role whose permission bindings have been
 * edited away grants nothing, and the acceptance would otherwise return a
 * cheerful 204 for an account that cannot administer anything.
 *
 * So the transaction asks the question it actually cares about, of the truth as
 * it now stands in the tables, before it consumes the one-shot capability.
 */
async function userIsViableAdministrator(
  tx: TransactionClient,
  tenant: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ present: boolean }[]>(
    Prisma.sql`SELECT ${viableAdministratorExists(
      Prisma.sql`${tenant}::uuid`,
      Prisma.sql`${userId}::uuid`,
    )} AS "present"`,
  );
  return rows[0]?.present === true;
}

async function appendAudit(
  tx: TransactionClient,
  tenant: string,
  eventType: string,
  entityId: string,
  metadata: Readonly<Record<string, string | number | boolean | null>>,
  at: Date,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: newId(),
      tenantId: tenant,
      // Null on both events. The issuer is a platform operator, and the
      // acceptor is not yet anybody Korvi knows — inventing a merchant user to
      // satisfy the column would be the exact confusion ADR-0018 refuses.
      actorUserId: null,
      branchId: null,
      terminalId: null,
      eventType,
      entityType: 'owner_bootstrap_invitation',
      entityId,
      metadata: { ...metadata },
      occurredAt: at,
    },
  });
}

/**
 * Issue an invitation, or hand back the one this operation already issued.
 *
 * Idempotent on `(tenantId, operationId)`: the same operation with the same
 * canonical intent replays the same logical invitation and re-derives the same
 * capability; the same operation with a different email, display name, actor or
 * tenant is a conflict, because it is a different decision wearing a retry's
 * name.
 *
 * Refuses outright once the merchant has a viable administrator. Bootstrap is
 * the bridge to the *first* one; after that, adding people is 4B-1's job and
 * goes through an authenticated administrator.
 */
export async function issueOwnerBootstrapInvitation(
  prisma: PrismaClient,
  signingKey: string,
  request: OwnerBootstrapIssueRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<IssuedOwnerBootstrap> {
  const tenant = request.tenantId;
  const operationId = normalizeControlPlaneOperation(request.operationId);
  const actor = normalizeControlPlaneActor(request.controlPlaneActorRef);
  const displayName = normalizeAdminName(request.displayName);
  const email = normalizeEmail(request.email);
  if (email === '') throw new OwnerBootstrapRefusedError('invalid-invitee');

  const requestHash = fingerprintOwnerBootstrap({
    tenantId: tenant,
    email,
    displayName,
    controlPlaneActorRef: actor,
  });

  const issued = await withTenant(prisma, tenant, async (tx) => {
    const at = clock();
    await lockTenant(tx, tenant);

    const existing = await tx.tenantOwnerBootstrapInvitation.findFirst({
      where: { tenantId: tenant, operationId },
      select: INVITATION_SELECT,
    });
    if (existing !== null) {
      // A replay only if it is asking for the same thing. Anything else under
      // the same operation id is a different decision.
      if (existing.requestHash !== requestHash) {
        throw new OwnerBootstrapRefusedError('idempotency-conflict');
      }
      return { row: existing, created: false };
    }

    // Two guards, and they are not the same guard.
    //
    // The first is permanent: this merchant has already been bootstrapped once,
    // so there is no *initial* owner left to establish and there never will be
    // again. It is checked after the replay branch above, so a retry of an
    // operation that was already accepted still replays rather than turning into
    // a refusal — a retry is not a new issuance.
    if (await hasCompletedInitialOwnerBootstrap(tx, tenant)) {
      throw new OwnerBootstrapRefusedError('already-established');
    }

    // The second is about the present, and it guards the case the first cannot
    // see: a merchant that came by an administrator some other way — 4B-1, a
    // migration, a seed — and never used this mechanism at all. Issuing there
    // would mint a second authority beside an existing one.
    if (await hasViableAdministrator(tx, tenant)) {
      throw new OwnerBootstrapRefusedError('already-established');
    }

    // One *live* invitation at a time, decided under the tenant lock rather
    // than by an index — Prisma cannot express a partial unique index, and the
    // lock is the stronger statement anyway.
    //
    // "Live" is unconsumed and unexpired, asked of the database in those terms.
    // An invitation that simply ran out of time is not in the way of anything:
    // it is a historical row, and the control plane issues a replacement under
    // a new operation.
    const live = await tx.tenantOwnerBootstrapInvitation.findFirst({
      where: { tenantId: tenant, consumedAt: null, expiresAt: { gt: at } },
      select: INVITATION_SELECT,
    });
    if (live !== null) throw new OwnerBootstrapRefusedError('already-invited');

    // Note what does *not* happen here: nothing is written to the expired row.
    // `consumedAt` means "a bearer presented this capability and it worked". A
    // clock passing a deadline is not that, and recording it as though it were
    // would make the audit trail claim an acceptance that never occurred.

    const id = nextId();
    await tx.tenantOwnerBootstrapInvitation.create({
      data: {
        id,
        tenantId: tenant,
        operationId,
        requestHash,
        email,
        displayName,
        controlPlaneActorRef: actor,
        expiresAt: bootstrapExpiryFrom(at),
        createdAt: at,
      },
    });

    await appendAudit(
      tx,
      tenant,
      'owner-bootstrap.invited',
      id,
      {
        controlPlaneActorRef: actor,
        operationId,
        // The bound address, which the operator supplied and can already see.
        // No capability, no fragment of one, and no hash of one.
        email,
      },
      at,
    );

    const row = await tx.tenantOwnerBootstrapInvitation.findFirst({
      where: { id, tenantId: tenant },
      select: INVITATION_SELECT,
    });
    if (row === null) {
      throw new DatabaseError('The invitation just written could not be read back.');
    }
    return { row, created: true };
  });

  const claims = {
    invitationId: issued.row.id,
    tenantId: issued.row.tenantId,
    expiresAt: iso(issued.row.expiresAt),
  };
  return {
    invitationId: claims.invitationId,
    tenantId: claims.tenantId,
    email: issued.row.email,
    expiresAt: claims.expiresAt,
    // Derived, not retrieved. The identical token comes back on a replay
    // because the row and the key are identical.
    capability: signOwnerBootstrapCapability(signingKey, claims),
    created: issued.created,
  };
}

// ---------------------------------------------------------------------------
// Accept — public
// ---------------------------------------------------------------------------

export interface OwnerBootstrapAcceptance {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
}

/**
 * Prove, cheaply, that this capability is worth spending scrypt on.
 *
 * Read-only, no locks, one short transaction. It answers exactly one question —
 * "could this possibly succeed?" — and it is **not** authority: every condition
 * it looks at is checked again under the locks below, because between this read
 * and that transaction the invitation can be consumed by somebody else.
 *
 * It exists because the alternative is a public, unauthenticated endpoint that
 * performs a memory-hard key derivation for any string at all. A caller with no
 * token could then buy 64 MiB and a CPU-second per request, which is a denial of
 * service with a free tier (ADR-0021).
 *
 * The signed expiry is compared against the row's. The claim was minted from
 * that column, so a mismatch means the token is describing an invitation that no
 * longer looks like the one it was signed for.
 *
 * Permanent closure is asked here too, so a tenant whose bootstrap is finished
 * forever costs nothing at all to refuse. That is the case worth spending a
 * cheap query on: an old capability against an established merchant can be
 * presented indefinitely, and it must never buy a key derivation.
 */
async function invitationLooksAcceptable(
  prisma: PrismaClient,
  claims: { invitationId: string; tenantId: string; expiresAt: string },
  now: Date,
): Promise<boolean> {
  return withTenant(prisma, claims.tenantId, async (tx) => {
    if (await hasCompletedInitialOwnerBootstrap(tx, claims.tenantId)) return false;

    const rows = await tx.$queryRaw<{ expiresAt: Date; consumedAt: Date | null }[]>`
      SELECT "expiresAt", "consumedAt"
        FROM "tenant_owner_bootstrap_invitations"
       WHERE "id" = ${claims.invitationId}::uuid AND "tenantId" = ${claims.tenantId}::uuid`;
    const row = rows.at(0);
    if (row === undefined) return false;
    if (iso(row.expiresAt) !== claims.expiresAt) return false;
    return isInvitationOpen(
      {
        expiresAt: iso(row.expiresAt),
        consumedAt: row.consumedAt === null ? null : iso(row.consumedAt),
      },
      now,
    );
  });
}

/**
 * Turn a capability plus a password into a merchant's first Owner.
 *
 * The order is the security argument, and every step depends on the one before
 * it:
 *
 *   1. the credential-creation policy, before anything else at all, so a
 *      refusal for a weak password can never double as "the capability was
 *      fine" — and so this holds for every caller, not only the HTTP one;
 *   2. verify the signature — nothing in the token is a fact until then;
 *   3. a cheap, lock-free preflight, so an unknown, forged, expired or already
 *      consumed capability is refused *before* any key derivation happens;
 *   4. hash the password, outside any transaction — scrypt is deliberately slow
 *      and memory-hard, and holding a tenant row lock across it would let one
 *      acceptance stall every administrative change in that merchant;
 *   5. enter the *signed* tenant's RLS context, so every statement below is
 *      confined by PostgreSQL and not by a `WHERE` somebody remembered;
 *   6. lock the tenant row, which serialises this against any other bootstrap
 *      and against 4B-1's authority changes;
 *   7. lock the invitation row, which is what makes single use single;
 *   8. re-check identity, expiry and consumption *by the row*, not by the token
 *      and not by the preflight;
 *   9. re-check that this merchant has never completed a bootstrap, and that it
 *      still has no viable administrator — the first permanent, the second
 *      about the present, and neither implying the other;
 *  10. create or claim the account named **by the row**, activate a membership,
 *      grant the tenant's *system* `owner` role found by key, write the
 *      already-derived hash;
 *  11. assert the postcondition — that this account is now a viable
 *      administrator in 4D's own terms — against the tables, not against the
 *      steps just taken;
 *  12. consume the invitation and write the audit row.
 *
 * Steps 5 to 12 are one transaction. A failure anywhere in them leaves no user,
 * no membership, no grant, no credential, no consumed invitation and no audit
 * row (ADR-0021).
 *
 * The preflight is a cost gate and nothing else. Two contenders holding the same
 * valid capability can both pass it and both derive a hash — which is fine,
 * because passing it requires possessing a real capability, and the locked
 * transaction still establishes exactly one Owner.
 *
 * The caller gets no session. A bootstrapped Owner signs in through the normal
 * login path like everybody else — auto-login here would mean a second way to
 * mint a session, on the one endpoint that is reachable without one.
 */
export async function acceptOwnerBootstrap(
  prisma: PrismaClient,
  signingKey: string,
  token: string,
  hashPassword: (password: string) => Promise<string>,
  password: string,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<OwnerBootstrapAcceptance> {
  // The credential-creation policy, at the authority boundary rather than only
  // at the HTTP one. This function is exported: an internal caller, a future
  // route, or a test that reached past the API layer would otherwise be able to
  // establish an Owner whose password Korvi would refuse to set anywhere else.
  // A password rule enforced only by the handler in front of it is a convention,
  // and this needs to be an invariant.
  //
  // First, before the signature is even looked at, so "weak password" can never
  // mean "and your capability was good". The API layer checks it too and turns
  // it into its own 400; that stays exactly as it was.
  assertNewPasswordAcceptable(password);

  const now = clock();
  const claims = verifyOwnerBootstrapCapability(signingKey, token, now);
  // One answer for a forged signature, a wrong version, a malformed payload
  // and a stale expiry. Cheap, and before anything expensive.
  if (claims === null) throw new OwnerBootstrapRefusedError('invalid-capability');

  // Still before anything expensive: a signature can be valid over an
  // invitation that never existed, has already been used, or has lapsed.
  if (!(await invitationLooksAcceptable(prisma, claims, now))) {
    throw new OwnerBootstrapRefusedError('invalid-capability');
  }

  // Now, and only now. Outside the transaction, so no authority lock is held
  // while scrypt runs.
  const passwordHash = await hashPassword(password);

  return withTenant(prisma, claims.tenantId, async (tx) => {
    const at = clock();
    const tenant = claims.tenantId;

    const tenantRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "tenants" WHERE "id" = ${tenant}::uuid FOR UPDATE`;
    if (tenantRows.length !== 1) throw new OwnerBootstrapRefusedError('invalid-capability');

    // The invitation, held. Two acceptances of the same capability queue here
    // and the second finds `consumedAt` set by the first.
    const locked = await tx.$queryRaw<
      {
        id: string;
        tenantId: string;
        email: string;
        displayName: string;
        expiresAt: Date;
        consumedAt: Date | null;
      }[]
    >`
      SELECT "id", "tenantId", "email", "displayName", "expiresAt", "consumedAt"
        FROM "tenant_owner_bootstrap_invitations"
       WHERE "id" = ${claims.invitationId}::uuid AND "tenantId" = ${tenant}::uuid
       FOR UPDATE`;
    const invitation = locked.at(0);
    if (invitation === undefined) throw new OwnerBootstrapRefusedError('invalid-capability');

    // The row's expiry, not the token's, and it must still be the expiry the
    // capability was signed for. A capability signed with a longer life than the
    // record allows must not outlive the record.
    if (iso(invitation.expiresAt) !== claims.expiresAt) {
      throw new OwnerBootstrapRefusedError('invalid-capability');
    }
    if (
      !isInvitationOpen(
        {
          expiresAt: iso(invitation.expiresAt),
          consumedAt: invitation.consumedAt === null ? null : iso(invitation.consumedAt),
        },
        at,
      )
    ) {
      throw new OwnerBootstrapRefusedError('invalid-capability');
    }

    // Permanent closure, authoritatively, under the tenant lock — the preflight
    // above is a cost gate and decides nothing. Two *different* invitations
    // cannot both succeed: the tenant lock serialises them, and the loser finds
    // this true because the winner consumed.
    //
    // The invitation being accepted right now is still unconsumed here, so this
    // never refuses on account of itself.
    if (await hasCompletedInitialOwnerBootstrap(tx, tenant)) {
      throw new OwnerBootstrapRefusedError('invalid-capability');
    }

    // And the present-tense guard, for a merchant that acquired an administrator
    // by some other route without ever using this mechanism.
    if (await hasViableAdministrator(tx, tenant)) {
      throw new OwnerBootstrapRefusedError('invalid-capability');
    }

    // Both facts come from the locked row. Neither the request nor the
    // capability carries them, which is why the invitee cannot redirect an
    // invitation to a different address or rename the account.
    const email = invitation.email;
    const displayName = invitation.displayName;

    // Claim the account if the address already exists in this tenant —
    // provisioning does not create one, but a 4B-1 administrator could have,
    // and creating a second row for the same address would violate
    // `(tenantId, email)` anyway.
    const existing = await tx.user.findFirst({
      where: { tenantId: tenant, email },
      select: { id: true, passwordHash: true },
    });
    if (existing !== null && existing.passwordHash !== null) {
      // An account with a credential already exists under the bound address.
      // Bootstrap does not overwrite credentials — that is password recovery,
      // and it is explicitly out of scope.
      throw new OwnerBootstrapRefusedError('invalid-capability');
    }

    const userId = existing?.id ?? nextId();
    if (existing === null) {
      await tx.user.create({
        data: {
          id: userId,
          tenantId: tenant,
          email,
          displayName,
          passwordHash,
          isActive: true,
          updatedAt: at,
        },
      });
    } else {
      await tx.user.updateMany({
        where: { id: userId, tenantId: tenant },
        data: { displayName, passwordHash, isActive: true, updatedAt: at },
      });
    }

    const membership = await tx.tenantMembership.findFirst({
      where: { tenantId: tenant, userId },
      select: { id: true },
    });
    if (membership === null) {
      await tx.tenantMembership.create({
        data: { id: nextId(), tenantId: tenant, userId, status: 'active', updatedAt: at },
      });
    } else {
      await tx.tenantMembership.updateMany({
        where: { id: membership.id, tenantId: tenant },
        data: { status: 'active', updatedAt: at },
      });
    }

    // Korvi's own Owner role, and nothing that merely answers to the name.
    // `isSystem` is the difference: provisioning installs the system roles
    // (ADR-0018), while 4B-1 lets an administrator create custom ones, and a
    // custom role keyed `owner` is a merchant's label rather than Korvi's
    // authority. There is no `roleId` on any path into this function, from the
    // client or the control plane, so this lookup is the only way in.
    const role = await tx.role.findFirst({
      where: { tenantId: tenant, key: OWNER_BOOTSTRAP_ROLE_KEY, isSystem: true },
      select: { id: true },
    });
    if (role === null) {
      // A provisioned tenant always has one. A tenant that does not is
      // half-built, and granting nothing is safer than granting something else.
      throw new OwnerBootstrapRefusedError('invalid-capability');
    }
    const granted = await tx.userRole.findFirst({
      where: { tenantId: tenant, userId, roleId: role.id },
      select: { id: true },
    });
    if (granted === null) {
      await tx.userRole.create({
        data: { id: nextId(), tenantId: tenant, userId, roleId: role.id },
      });
    }

    // The postcondition, asked of the tables rather than assumed from the four
    // writes above, and asked *before* the capability is spent.
    //
    // Each step on its own succeeded. That is not the same as having established
    // an administrator: if the system Owner role's permission bindings have been
    // edited away, the grant above grants nothing, and this transaction would
    // otherwise consume a one-shot invitation, report success, and leave a
    // merchant with an Owner who cannot administer it and no way to get another
    // capability.
    //
    // Failing here fails closed. The whole transaction rolls back — no user, no
    // membership, no grant, no credential — and the invitation stays unconsumed,
    // so the same capability still works once the tenant is repaired.
    if (!(await userIsViableAdministrator(tx, tenant, userId))) {
      throw new OwnerBootstrapRefusedError('invalid-capability');
    }

    const consumed = await tx.tenantOwnerBootstrapInvitation.updateMany({
      where: { id: invitation.id, tenantId: tenant, consumedAt: null },
      data: { consumedAt: at },
    });
    // Belt and braces over the row lock: if this is ever not 1, two acceptances
    // reached here holding the same row, which cannot happen.
    if (consumed.count !== 1) throw new OwnerBootstrapRefusedError('invalid-capability');

    await appendAudit(
      tx,
      tenant,
      'owner-bootstrap.accepted',
      invitation.id,
      {
        userId,
        email,
        // Never the token, never the password, never the hash.
        credentialEstablished: true,
      },
      at,
    );

    return { userId, tenantId: tenant, email };
  });
}
