import {
  activateTenant,
  assignTenantPlan,
  issueOwnerBootstrapInvitation,
  listPlatformTenantAudit,
  listPlatformTenants,
  provisionTenant,
  readPlatformTenantDetail,
  reactivateTenant,
  suspendTenant,
} from '@korvi/database';
import type {
  IssuedOwnerBootstrap,
  PlatformAuditPage,
  PlatformTenantDetail,
  PlatformTenantListQuery,
  PlatformTenantPage,
  PrismaClient,
  ProvisionedTenant,
  TenantLifecycleResult,
  TenantPlanAssignmentResult,
} from '@korvi/database';
import type {
  CommercialAccountState,
  EntitlementGrant,
  TenantLifecycleState,
  Vertical,
} from '@korvi/domain';

export interface PlatformActor {
  readonly controlPlaneActorRef: string;
}

export interface NewPlatformTenant {
  readonly operationId: string;
  readonly slug: string;
  readonly name: string;
  readonly vatNumber: string | null;
  readonly vertical: Vertical;
}

export interface PlatformPlanAssignment {
  readonly operationId: string;
  readonly planKey: string;
  readonly planRevision: number;
  readonly accountState: CommercialAccountState;
  readonly entitlements: readonly EntitlementGrant[];
}

export interface PlatformOwnerBootstrapInvitation {
  readonly operationId: string;
  readonly email: string;
  readonly displayName: string;
}

export class PlatformOwnerBootstrapUnavailableError extends Error {
  public override readonly name = 'PlatformOwnerBootstrapUnavailableError';

  public constructor() {
    super('Owner bootstrap signing authority is not configured.');
  }
}

export interface PlatformService {
  listTenants(
    actor: PlatformActor,
    query: Omit<PlatformTenantListQuery, 'controlPlaneActorRef'>,
  ): Promise<PlatformTenantPage>;
  getTenant(actor: PlatformActor, tenantId: string): Promise<PlatformTenantDetail | null>;
  createTenant(actor: PlatformActor, input: NewPlatformTenant): Promise<ProvisionedTenant>;
  activateTenant(
    actor: PlatformActor,
    tenantId: string,
    operationId: string,
  ): Promise<TenantLifecycleResult>;
  suspendTenant(
    actor: PlatformActor,
    tenantId: string,
    operationId: string,
    reason: string,
  ): Promise<TenantLifecycleResult>;
  reactivateTenant(
    actor: PlatformActor,
    tenantId: string,
    operationId: string,
  ): Promise<TenantLifecycleResult>;
  assignPlan(
    actor: PlatformActor,
    tenantId: string,
    input: PlatformPlanAssignment,
  ): Promise<TenantPlanAssignmentResult>;
  issueOwnerBootstrap(
    actor: PlatformActor,
    tenantId: string,
    input: PlatformOwnerBootstrapInvitation,
  ): Promise<IssuedOwnerBootstrap>;
  listAudit(
    actor: PlatformActor,
    tenantId: string,
    input?: { readonly cursor?: string; readonly limit?: number },
  ): Promise<PlatformAuditPage | null>;
}

/**
 * Build the SaaS control-plane authority.
 *
 * The owner-bootstrap signing key is deliberately injectable. The default keeps
 * the existing lazy server composition intact while still failing closed when
 * the deployment did not configure BOOTSTRAP_SIGNING_KEY. The key is never
 * returned, persisted or logged; only the already-reviewed bootstrap authority
 * receives it to derive the one-shot capability (ADR-0021).
 */
export function createPlatformService(
  prisma: PrismaClient,
  ownerBootstrapSigningKey: string | undefined = process.env['BOOTSTRAP_SIGNING_KEY'],
): PlatformService {
  return {
    async listTenants(actor, query) {
      return listPlatformTenants(prisma, {
        ...query,
        controlPlaneActorRef: actor.controlPlaneActorRef,
      });
    },

    async getTenant(actor, tenantId) {
      return readPlatformTenantDetail(prisma, actor.controlPlaneActorRef, tenantId);
    },

    async createTenant(actor, input) {
      return provisionTenant(prisma, {
        ...input,
        controlPlaneActorRef: actor.controlPlaneActorRef,
      });
    },

    async activateTenant(actor, tenantId, operationId) {
      return activateTenant(prisma, {
        tenantId,
        operationId,
        controlPlaneActorRef: actor.controlPlaneActorRef,
      });
    },

    async suspendTenant(actor, tenantId, operationId, reason) {
      return suspendTenant(prisma, {
        tenantId,
        operationId,
        controlPlaneActorRef: actor.controlPlaneActorRef,
        reason,
      });
    },

    async reactivateTenant(actor, tenantId, operationId) {
      return reactivateTenant(prisma, {
        tenantId,
        operationId,
        controlPlaneActorRef: actor.controlPlaneActorRef,
      });
    },

    async assignPlan(actor, tenantId, input) {
      return assignTenantPlan(prisma, {
        tenantId,
        ...input,
        controlPlaneActorRef: actor.controlPlaneActorRef,
      });
    },

    async issueOwnerBootstrap(actor, tenantId, input) {
      if (ownerBootstrapSigningKey === undefined) {
        throw new PlatformOwnerBootstrapUnavailableError();
      }
      return issueOwnerBootstrapInvitation(prisma, ownerBootstrapSigningKey, {
        tenantId,
        ...input,
        controlPlaneActorRef: actor.controlPlaneActorRef,
      });
    },

    async listAudit(actor, tenantId, input = {}) {
      return listPlatformTenantAudit(prisma, actor.controlPlaneActorRef, tenantId, input);
    },
  };
}

export type { TenantLifecycleState };
