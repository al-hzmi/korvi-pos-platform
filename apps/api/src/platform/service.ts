import {
  activateTenant,
  assignTenantPlan,
  listPlatformTenantAudit,
  listPlatformTenants,
  provisionTenant,
  readPlatformTenantDetail,
  reactivateTenant,
  suspendTenant,
} from '@korvi/database';
import type {
  PlatformTenantDetail,
  PlatformTenantListQuery,
  PlatformTenantPage,
  PrismaClient,
  TenantLifecycleResult,
  TenantPlanAssignmentResult,
  ProvisionedTenant,
  PlatformAuditEntry,
} from '@korvi/database';
import type { CommercialAccountState, EntitlementGrant, TenantLifecycleState, Vertical } from '@korvi/domain';

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

export interface PlatformService {
  listTenants(
    actor: PlatformActor,
    query: Omit<PlatformTenantListQuery, 'controlPlaneActorRef'>,
  ): Promise<PlatformTenantPage>;
  getTenant(actor: PlatformActor, tenantId: string): Promise<PlatformTenantDetail | null>;
  createTenant(actor: PlatformActor, input: NewPlatformTenant): Promise<ProvisionedTenant>;
  activateTenant(actor: PlatformActor, tenantId: string, operationId: string): Promise<TenantLifecycleResult>;
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
  listAudit(tenantId: string, limit?: number): Promise<readonly PlatformAuditEntry[]>;
}

export function createPlatformService(prisma: PrismaClient): PlatformService {
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

    async listAudit(tenantId, limit) {
      return listPlatformTenantAudit(prisma, tenantId, limit);
    },
  };
}

export type { TenantLifecycleState };
