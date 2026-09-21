import {
  CategoryBootstrapError,
  newId,
  normalizeCategoryBootstrap,
} from '@korvi/domain';
import { DatabaseError } from '../errors.js';
import { tenantParam } from '../repositories/mapping.js';
import { withTenant } from '../tenant-context.js';
import type {
  CategoryBootstrapDraft,
  TenantScope,
} from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

export type CategoryBootstrapRefusal = 'invalid-input' | 'category-inactive';

export class CategoryBootstrapRefusedError extends DatabaseError {
  public override readonly name = 'CategoryBootstrapRefusedError';

  public constructor(public readonly detail: CategoryBootstrapRefusal) {
    super('Category bootstrap refused: ' + detail);
  }
}

export interface CategoryBootstrapActor {
  readonly userId: string;
}

export interface AdminCategoryBootstrap {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly sortOrder: number;
  readonly isActive: true;
  readonly createdAt: string;
}

export interface EnsureCategoryResult {
  readonly category: AdminCategoryBootstrap;
  readonly created: boolean;
}

function asCategory(row: {
  id: string;
  nameAr: string;
  nameEn: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: Date;
}): AdminCategoryBootstrap {
  if (!row.isActive) throw new CategoryBootstrapRefusedError('category-inactive');
  return {
    id: row.id,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    sortOrder: row.sortOrder,
    isActive: true,
    createdAt: row.createdAt.toISOString(),
  };
}

async function existingByName(
  tx: TransactionClient,
  tenant: string,
  nameAr: string,
): Promise<AdminCategoryBootstrap | null> {
  const row = await tx.category.findFirst({
    where: { tenantId: tenant, nameAr },
    select: {
      id: true,
      nameAr: true,
      nameEn: true,
      sortOrder: true,
      isActive: true,
      createdAt: true,
    },
  });
  return row === null ? null : asCategory(row);
}

export async function ensureCategoryWithin(
  tx: TransactionClient,
  tenant: string,
  actor: CategoryBootstrapActor,
  draft: CategoryBootstrapDraft,
  at: Date,
  nextId: () => string = newId,
): Promise<EnsureCategoryResult> {
  let input;
  try {
    input = normalizeCategoryBootstrap(draft);
  } catch (error) {
    if (error instanceof CategoryBootstrapError) {
      throw new CategoryBootstrapRefusedError('invalid-input');
    }
    throw error;
  }

  const existing = await existingByName(tx, tenant, input.nameAr);
  if (existing !== null) return { category: existing, created: false };

  const id = nextId();
  try {
    await tx.category.create({
      data: {
        id,
        tenantId: tenant,
        nameAr: input.nameAr,
        nameEn: input.nameEn,
        sortOrder: input.sortOrder,
        isActive: true,
        createdAt: at,
        updatedAt: at,
      },
    });
  } catch (error) {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      (error as { code?: unknown }).code !== 'P2002'
    ) {
      throw error;
    }
    const raced = await existingByName(tx, tenant, input.nameAr);
    if (raced === null) {
      throw new DatabaseError('Category uniqueness collision could not be resolved.');
    }
    return { category: raced, created: false };
  }

  await tx.auditEvent.create({
    data: {
      id: nextId(),
      tenantId: tenant,
      actorUserId: actor.userId,
      branchId: null,
      terminalId: null,
      eventType: 'category.created',
      entityType: 'category',
      entityId: id,
      metadata: {
        nameAr: input.nameAr,
        hasEnglishName: input.nameEn !== null,
        sortOrder: input.sortOrder,
      },
      occurredAt: at,
    },
  });

  const category = await existingByName(tx, tenant, input.nameAr);
  if (category === null || category.id !== id) {
    throw new DatabaseError('The category just created could not be read back.');
  }
  return { category, created: true };
}

export async function ensureCategory(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CategoryBootstrapActor,
  draft: CategoryBootstrapDraft,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<EnsureCategoryResult> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, (tx) =>
    ensureCategoryWithin(tx, tenant, actor, draft, clock(), nextId),
  );
}
