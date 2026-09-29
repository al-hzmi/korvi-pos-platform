import { createHash } from 'node:crypto';
import {
  LotAdminRefusedError,
  enableProductLotTracking,
  readProductLotConfig,
  recordInventoryLotReclassification,
  updateInventoryLotStatus,
  updateProductLotPolicy,
} from '@korvi/database';
import { requirePrincipalPermission, tenantId as brandTenantId } from '@korvi/domain';
import type {
  EnableLotTrackingRequest,
  LotAdminRefusal,
  PrismaClient,
  ProductLotAdminConfig,
  RecordLotReclassificationRequest,
  UpdateLotPolicyRequest,
  UpdateLotStatusRequest,
} from '@korvi/database';
import type { AuthenticatedPrincipal, TenantScope } from '@korvi/domain';

export type LotAdminFailureReason = LotAdminRefusal;

export type LotAdminResult<T> =
  | { readonly outcome: 'success'; readonly value: T }
  | { readonly outcome: 'failure'; readonly reason: LotAdminFailureReason };

export interface LotEnableInput {
  readonly selectionPolicy: 'fefo' | 'fifo';
  readonly dateRequirement: 'optional' | 'required';
}

export interface LotPolicyUpdateInput {
  readonly expectedRevision: string;
  readonly selectionPolicy?: 'fefo' | 'fifo' | undefined;
  readonly dateRequirement?: 'optional' | 'required' | undefined;
}

export interface LotStatusUpdateInput {
  readonly expectedRevision: string;
  readonly status: 'active' | 'blocked' | 'closed';
}

export interface LotReclassificationInput {
  readonly operationId: string;
  readonly productId: string;
  readonly branchId: string;
  readonly expectedBalanceRevision: string;
  readonly reason: string;
  readonly lines: readonly {
    readonly lotId: string;
    readonly quantityScaled: string;
  }[];
}

export interface MerchantLotAdminService {
  read(principal: AuthenticatedPrincipal, productId: string): Promise<ProductLotAdminConfig | null>;
  enable(
    principal: AuthenticatedPrincipal,
    productId: string,
    input: LotEnableInput,
  ): Promise<LotAdminResult<ProductLotAdminConfig>>;
  updatePolicy(
    principal: AuthenticatedPrincipal,
    productId: string,
    input: LotPolicyUpdateInput,
  ): Promise<LotAdminResult<ProductLotAdminConfig>>;
  updateStatus(
    principal: AuthenticatedPrincipal,
    lotId: string,
    input: LotStatusUpdateInput,
  ): Promise<LotAdminResult<ProductLotAdminConfig>>;
  reclassify(
    principal: AuthenticatedPrincipal,
    input: LotReclassificationInput,
  ): Promise<LotAdminResult<ProductLotAdminConfig>>;
}

function scopeOf(principal: AuthenticatedPrincipal): TenantScope {
  return { tenantId: brandTenantId(principal.tenantId) };
}

function hashReclassification(
  principal: AuthenticatedPrincipal,
  input: LotReclassificationInput,
): string {
  const lines = [...input.lines]
    .map((line) => [line.lotId.trim().toLowerCase(), BigInt(line.quantityScaled).toString()])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  const canonical = JSON.stringify([
    'lot-reclassification.v1',
    principal.userId,
    input.productId.trim().toLowerCase(),
    input.branchId.trim().toLowerCase(),
    BigInt(input.expectedBalanceRevision).toString(),
    input.reason.trim(),
    lines,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

export function createMerchantLotAdminService(
  prisma: PrismaClient,
  options: { readonly now?: () => Date } = {},
): MerchantLotAdminService {
  const now = options.now ?? (() => new Date());

  async function translate<T>(work: () => Promise<T>): Promise<LotAdminResult<T>> {
    try {
      return { outcome: 'success', value: await work() };
    } catch (error) {
      if (error instanceof LotAdminRefusedError) {
        return { outcome: 'failure', reason: error.detail };
      }
      throw error;
    }
  }

  return {
    async read(principal, productId) {
      requirePrincipalPermission(principal, 'lot.manage');
      return readProductLotConfig(prisma, scopeOf(principal), productId, now());
    },

    async enable(principal, productId, input) {
      requirePrincipalPermission(principal, 'lot.manage');
      const request: EnableLotTrackingRequest = {
        selectionPolicy: input.selectionPolicy,
        dateRequirement: input.dateRequirement,
        occurredAt: now().toISOString(),
      };
      return translate(() =>
        enableProductLotTracking(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          productId,
          request,
        ),
      );
    },

    async updatePolicy(principal, productId, input) {
      requirePrincipalPermission(principal, 'lot.manage');
      const request: UpdateLotPolicyRequest = {
        expectedRevision: input.expectedRevision,
        ...(input.selectionPolicy === undefined ? {} : { selectionPolicy: input.selectionPolicy }),
        ...(input.dateRequirement === undefined ? {} : { dateRequirement: input.dateRequirement }),
        occurredAt: now().toISOString(),
      };
      return translate(() =>
        updateProductLotPolicy(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          productId,
          request,
        ),
      );
    },

    async updateStatus(principal, lotId, input) {
      requirePrincipalPermission(principal, 'lot.manage');
      const request: UpdateLotStatusRequest = {
        expectedRevision: input.expectedRevision,
        status: input.status,
        occurredAt: now().toISOString(),
      };
      return translate(() =>
        updateInventoryLotStatus(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          lotId,
          request,
        ),
      );
    },

    async reclassify(principal, input) {
      requirePrincipalPermission(principal, 'lot.manage');
      let requestHash: string;
      try {
        requestHash = hashReclassification(principal, input);
      } catch {
        return { outcome: 'failure', reason: 'invalid-input' };
      }
      const request: RecordLotReclassificationRequest = {
        operationId: input.operationId,
        requestHash,
        productId: input.productId,
        branchId: input.branchId,
        expectedBalanceRevision: input.expectedBalanceRevision,
        reason: input.reason,
        lines: input.lines,
        occurredAt: now().toISOString(),
      };
      return translate(() =>
        recordInventoryLotReclassification(
          prisma,
          scopeOf(principal),
          { userId: principal.userId },
          request,
        ),
      );
    },
  };
}
