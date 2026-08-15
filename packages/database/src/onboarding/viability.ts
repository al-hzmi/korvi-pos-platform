import { Prisma } from '../../generated/client/client.js';
import type { Permission } from '@korvi/domain';

/**
 * What Korvi means by "this merchant has somebody who can run it".
 *
 * One definition, in one place, because it is asked in three different
 * situations and two of them decide authority:
 *
 *   - 4D readiness reports it as evidence (`readTenantOnboardingReadiness`);
 *   - owner bootstrap refuses to issue or accept once it is true;
 *   - owner bootstrap asserts it of the account it has just created, before it
 *     consumes the invitation.
 *
 * Two copies of this predicate would be two things that could drift, and a
 * bootstrap that *established* less than readiness demands would hand back a 204
 * for an Owner who cannot actually administer the shop.
 *
 * This is a **present-tense** predicate, and it is used as one. It answers "does
 * this merchant have an administrator right now", which is the correct guard
 * before a first bootstrap and a dangerous one after: it goes false again
 * whenever authority lapses, and a bootstrap gate resting on it would reopen for
 * a merchant that has merely lost its Owner. Permanent closure is a separate,
 * monotonic question and lives with the bootstrap authority (ADR-0021).
 *
 * Note what is deliberately not here. No role name — not `owner`, not `admin`.
 * Korvi's truth about authority is a permission held through any role, so asking
 * about a role name would answer a different question.
 */

/**
 * Both, and effectively — held through some role, not merely named on one.
 *
 * `users.manage` alone is 4B-1's administrative authority and is *not* this:
 * somebody who can add staff but cannot configure the shop cannot finish
 * onboarding, which is exactly what readiness is measuring. `settings.manage`
 * alone is the mirror image. 4D requires both, so this requires both.
 */
export const VIABLE_ADMINISTRATOR_PERMISSIONS: readonly Permission[] = [
  'settings.manage',
  'users.manage',
];

/** `u` holds `permission` through any role granted to them in this tenant. */
function holds(permission: Permission): Prisma.Sql {
  return Prisma.sql`
    EXISTS (
      SELECT 1
        FROM "user_roles" ur
        JOIN "role_permissions" rp
          ON rp."tenantId" = ur."tenantId"
         AND rp."roleId" = ur."roleId"
       WHERE ur."tenantId" = u."tenantId"
         AND ur."userId" = u."id"
         AND rp."permissionKey" = ${permission}
    )`;
}

/**
 * The predicate itself, as a composable fragment.
 *
 * A fragment rather than a function that runs its own query, so readiness can
 * keep evaluating all six pieces of evidence in one statement while bootstrap
 * asks the same question under its locks. `tenant` and `user` arrive as
 * `Prisma.Sql` because the two callers name the tenant differently — readiness
 * correlates against `t."id"`, bootstrap binds a parameter — and neither is
 * ever a string spliced into SQL.
 *
 * Pass `user` to ask it of one specific account: that is the postcondition form,
 * "is *this* person now a viable administrator", which is the question worth
 * asking after establishing one.
 */
export function viableAdministratorExists(tenant: Prisma.Sql, user?: Prisma.Sql): Prisma.Sql {
  const scopedToUser = user === undefined ? Prisma.empty : Prisma.sql`AND u."id" = ${user}`;
  return Prisma.sql`
    EXISTS (
      SELECT 1
        FROM "users" u
        JOIN "tenant_memberships" m
          ON m."tenantId" = u."tenantId"
         AND m."userId" = u."id"
       WHERE u."tenantId" = ${tenant}
         ${scopedToUser}
         AND u."isActive" = TRUE
         AND u."passwordHash" IS NOT NULL
         AND m."status" = 'active'
         AND ${Prisma.join(VIABLE_ADMINISTRATOR_PERMISSIONS.map(holds), ' AND ')}
    )`;
}
