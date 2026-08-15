import { TENANT_LIFECYCLE_STATES, evaluateOnboardingReadiness } from '@korvi/domain';
import { Prisma } from '../../generated/client/client.js';
import { withTenant } from '../tenant-context.js';
import { oneOf, tenantParam } from '../repositories/mapping.js';
import { viableAdministratorExists } from './viability.js';
import type { OnboardingReadiness, TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';

interface ReadinessEvidenceRow {
  tenantStatus: string;
  settingsPresent: boolean;
  activeBranchPresent: boolean;
  activeTerminalPresent: boolean;
  viableAdministratorPresent: boolean;
  activeProductPresent: boolean;
}

/**
 * Read the merchant's current onboarding evidence under tenant RLS.
 *
 * No onboarding completion flag exists. This query is intentionally read-only:
 * readiness changes when the underlying operational truth changes.
 */
export async function readTenantOnboardingReadiness(
  prisma: PrismaClient,
  scope: TenantScope,
): Promise<OnboardingReadiness | null> {
  const tenantId = tenantParam(scope);

  return withTenant(prisma, tenantId, async (tx) => {
    const rows = await tx.$queryRaw<ReadinessEvidenceRow[]>`
      SELECT
        t."status" AS "tenantStatus",

        EXISTS (
          SELECT 1
            FROM "tenant_settings" s
           WHERE s."tenantId" = t."id"
        ) AS "settingsPresent",

        EXISTS (
          SELECT 1
            FROM "branches" b
           WHERE b."tenantId" = t."id"
             AND b."isActive" = TRUE
        ) AS "activeBranchPresent",

        EXISTS (
          SELECT 1
            FROM "terminals" terminal
            JOIN "branches" branch
              ON branch."tenantId" = terminal."tenantId"
             AND branch."id" = terminal."branchId"
           WHERE terminal."tenantId" = t."id"
             AND terminal."isActive" = TRUE
             AND branch."isActive" = TRUE
        ) AS "activeTerminalPresent",

        ${viableAdministratorExists(Prisma.sql`t."id"`)} AS "viableAdministratorPresent",

        EXISTS (
          SELECT 1
            FROM "products" product
           WHERE product."tenantId" = t."id"
             AND product."isActive" = TRUE
        ) AS "activeProductPresent"

      FROM "tenants" t
      WHERE t."id" = ${tenantId}::uuid
    `;

    const row = rows[0];
    if (row === undefined) return null;

    return evaluateOnboardingReadiness({
      tenantStatus: oneOf(TENANT_LIFECYCLE_STATES, row.tenantStatus, 'tenants.status'),
      settingsPresent: row.settingsPresent,
      activeBranchPresent: row.activeBranchPresent,
      activeTerminalPresent: row.activeTerminalPresent,
      viableAdministratorPresent: row.viableAdministratorPresent,
      activeProductPresent: row.activeProductPresent,
    });
  });
}
