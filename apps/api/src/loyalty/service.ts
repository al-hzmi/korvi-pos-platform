import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import {
  LoyaltyPolicyRefusedError,
  createLoyaltyPolicy,
  enrollLoyaltyCustomer,
  readLoyaltyLedger,
  readLoyaltyPolicy,
  reviseLoyaltyPolicy,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';
import type {
  LoyaltyLedgerView,
  LoyaltyPolicyInput,
  LoyaltyPolicyRefusal,
  LoyaltyPolicyView,
  PrismaClient,
} from '@korvi/database';

export type LoyaltyCommandResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: LoyaltyPolicyRefusal };

export interface MerchantLoyaltyService {
  policy(principal: AuthenticatedPrincipal): Promise<LoyaltyPolicyView | null>;
  create(
    principal: AuthenticatedPrincipal,
    input: LoyaltyPolicyInput,
  ): Promise<LoyaltyCommandResult<LoyaltyPolicyView>>;
  revise(
    principal: AuthenticatedPrincipal,
    expectedRevision: string,
    input: Partial<LoyaltyPolicyInput> & { readonly status?: 'draft' | 'active' | 'paused' },
  ): Promise<LoyaltyCommandResult<LoyaltyPolicyView>>;
  enroll(
    principal: AuthenticatedPrincipal,
    customerId: string,
    confirmed: boolean,
  ): Promise<LoyaltyCommandResult<{ readonly enrollmentId: string }>>;
  ledger(principal: AuthenticatedPrincipal, customerId: string): Promise<LoyaltyLedgerView>;
}

function scope(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

async function attempt<T>(work: () => Promise<T>): Promise<LoyaltyCommandResult<T>> {
  try {
    return { outcome: 'success', value: await work() };
  } catch (error) {
    if (error instanceof LoyaltyPolicyRefusedError) {
      return { outcome: 'failure', reason: error.detail };
    }
    throw error;
  }
}

export function createMerchantLoyaltyService(prisma: PrismaClient): MerchantLoyaltyService {
  return {
    policy(principal) {
      requirePrincipalPermission(principal, 'loyalty.manage');
      return readLoyaltyPolicy(prisma, scope(principal));
    },
    create(principal, input) {
      requirePrincipalPermission(principal, 'loyalty.manage');
      return attempt(() =>
        createLoyaltyPolicy(prisma, scope(principal), { userId: principal.userId }, input),
      );
    },
    revise(principal, expectedRevision, input) {
      requirePrincipalPermission(principal, 'loyalty.manage');
      return attempt(() =>
        reviseLoyaltyPolicy(
          prisma,
          scope(principal),
          { userId: principal.userId },
          expectedRevision,
          input,
        ),
      );
    },
    enroll(principal, customerId, confirmed) {
      requirePrincipalPermission(principal, 'loyalty.manage');
      requirePrincipalPermission(principal, 'customer.write');
      return attempt(async () => ({
        enrollmentId: await enrollLoyaltyCustomer(
          prisma,
          scope(principal),
          { userId: principal.userId },
          customerId,
          confirmed,
        ),
      }));
    },
    ledger(principal, customerId) {
      requirePrincipalPermission(principal, 'customer.read');
      return readLoyaltyLedger(prisma, scope(principal), customerId);
    },
  };
}
