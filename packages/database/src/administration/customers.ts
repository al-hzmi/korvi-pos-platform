import { createHash } from 'node:crypto';
import { newId } from '@korvi/domain';
import { withTenant } from '../tenant-context.js';
import { DatabaseError } from '../errors.js';
import { tenantParam } from '../repositories/mapping.js';
import type { TenantScope } from '@korvi/domain';
import type { PrismaClient } from '../client.js';
import type { TransactionClient } from '../tenant-context.js';

export const MAX_CUSTOMER_PAGE = 100;
const MAX_CURSOR_BYTES = 768;
const CREATE_SCOPE = 'customer.create';
const UPDATE_SCOPE = 'customer.update';

export type CustomerAdminRefusal =
  | 'unknown-customer'
  | 'phone-taken'
  | 'invalid-cursor'
  | 'idempotency-conflict'
  | 'operation-in-progress';

export class CustomerAdminRefusedError extends DatabaseError {
  public override readonly name = 'CustomerAdminRefusedError';
  public readonly detail: CustomerAdminRefusal;

  public constructor(detail: CustomerAdminRefusal) {
    super(`Customer operation refused: ${detail}`);
    this.detail = detail;
  }
}

export interface CustomerActor {
  /** Authenticated merchant user. Never accepted from an HTTP payload. */
  readonly userId: string;
}

export interface AdminCustomer {
  readonly id: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CustomerListQuery {
  readonly search?: string | undefined;
  readonly status?: 'active' | 'inactive' | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface CustomerPage {
  readonly items: readonly AdminCustomer[];
  readonly nextCursor: string | null;
}

export interface CustomerSaleLink {
  readonly id: string;
  readonly invoiceNumber: string | null;
  readonly status: string;
  readonly issuedAt: string;
  readonly currency: string;
  readonly totalMinor: string;
}

export interface CustomerDetail extends AdminCustomer {
  readonly salesCount: number;
  readonly recentSales: readonly CustomerSaleLink[];
}

export interface CustomerCreateRequest {
  readonly operationId: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
}

export interface CustomerUpdateRequest {
  readonly operationId: string;
  readonly nameAr?: string | undefined;
  readonly nameEn?: string | null | undefined;
  readonly phone?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly vatNumber?: string | null | undefined;
  readonly isActive?: boolean | undefined;
}

export interface CustomerMutationResult {
  readonly customer: AdminCustomer;
  readonly replayed: boolean;
}

interface CustomerRow {
  id: string;
  nameAr: string;
  nameEn: string | null;
  phone: string | null;
  email: string | null;
  vatNumber: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface CursorValue {
  readonly nameAr: string;
  readonly id: string;
}

function asCustomer(row: CustomerRow): AdminCustomer {
  return {
    id: row.id,
    nameAr: row.nameAr,
    nameEn: row.nameEn,
    phone: row.phone,
    email: row.email,
    vatNumber: row.vatNumber,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorValue | null {
  if (cursor === undefined || cursor === '') return null;
  if (cursor.length > MAX_CURSOR_BYTES) throw new CustomerAdminRefusedError('invalid-cursor');
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    if (Buffer.from(raw, 'utf8').toString('base64url') !== cursor) {
      throw new CustomerAdminRefusedError('invalid-cursor');
    }
    const value: unknown = JSON.parse(raw);
    if (
      value === null ||
      typeof value !== 'object' ||
      typeof (value as Record<string, unknown>)['nameAr'] !== 'string' ||
      typeof (value as Record<string, unknown>)['id'] !== 'string'
    ) {
      throw new CustomerAdminRefusedError('invalid-cursor');
    }
    return {
      nameAr: (value as { nameAr: string }).nameAr,
      id: (value as { id: string }).id,
    };
  } catch (error) {
    if (error instanceof CustomerAdminRefusedError) throw error;
    throw new CustomerAdminRefusedError('invalid-cursor');
  }
}

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_CUSTOMER_PAGE);
}

function fingerprint(value: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function lockTenant(tx: TransactionClient, tenant: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "tenants"
     WHERE "id" = ${tenant}::uuid
     FOR UPDATE`;
  if (rows.length !== 1) {
    throw new DatabaseError('The tenant behind the customer operation could not be locked.');
  }
}

async function reserveOperation(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
  requestHash: string,
  nextId: () => string,
): Promise<{ readonly created: boolean; readonly replay: AdminCustomer | null }> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO "idempotency_keys"
      ("id","tenantId","scope","operationId","status","requestHash","createdAt")
    VALUES
      (${nextId()}::uuid, ${tenant}::uuid, ${scope}, ${operationId}, 'reserved', ${requestHash}, NOW())
    ON CONFLICT ("tenantId","scope","operationId") DO NOTHING
    RETURNING "id"`;

  const rows = await tx.$queryRaw<
    {
      status: string;
      requestHash: string | null;
      resultType: string | null;
      resultSnapshot: unknown;
    }[]
  >`
    SELECT "status","requestHash","resultType","resultSnapshot"
      FROM "idempotency_keys"
     WHERE "tenantId" = ${tenant}::uuid
       AND "scope" = ${scope}
       AND "operationId" = ${operationId}
     FOR UPDATE`;
  const row = rows.at(0);
  if (row === undefined) throw new DatabaseError('Customer idempotency reservation disappeared.');
  if (row.requestHash !== requestHash) throw new CustomerAdminRefusedError('idempotency-conflict');

  if (row.status === 'completed') {
    if (row.resultType !== 'customer' || row.resultSnapshot === null) {
      throw new DatabaseError('Completed customer operation has no authoritative snapshot.');
    }
    return { created: false, replay: row.resultSnapshot as AdminCustomer };
  }
  if (inserted.length === 0) throw new CustomerAdminRefusedError('operation-in-progress');
  return { created: true, replay: null };
}

async function completeOperation(
  tx: TransactionClient,
  tenant: string,
  scope: string,
  operationId: string,
  customer: AdminCustomer,
  at: Date,
): Promise<void> {
  const changed = await tx.idempotencyKey.updateMany({
    where: { tenantId: tenant, scope, operationId, status: 'reserved' },
    data: {
      status: 'completed',
      resultType: 'customer',
      resultId: customer.id,
      resultSnapshot: { ...customer },
      completedAt: at,
    },
  });
  if (changed.count !== 1) {
    throw new DatabaseError('Customer operation could not complete its idempotency record.');
  }
}

async function appendAudit(
  tx: TransactionClient,
  tenant: string,
  actor: CustomerActor,
  eventType: 'customer.created' | 'customer.updated',
  customerId: string,
  metadata: Readonly<Record<string, string | boolean | null>>,
  at: Date,
  nextId: () => string,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      id: nextId(),
      tenantId: tenant,
      actorUserId: actor.userId,
      branchId: null,
      terminalId: null,
      eventType,
      entityType: 'customer',
      entityId: customerId,
      metadata: { ...metadata },
      occurredAt: at,
    },
  });
}

export async function listMerchantCustomers(
  prisma: PrismaClient,
  scope: TenantScope,
  query: CustomerListQuery = {},
): Promise<CustomerPage> {
  const tenant = tenantParam(scope);
  const limit = pageSize(query.limit);
  const after = decodeCursor(query.cursor);
  const search = query.search?.trim() ?? '';

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const rows: CustomerRow[] = await tx.customer.findMany({
      where: {
        tenantId: tenant,
        ...(query.status === undefined ? {} : { isActive: query.status === 'active' }),
        ...(search === ''
          ? {}
          : {
              OR: [
                { nameAr: { contains: search, mode: 'insensitive' } },
                { nameEn: { contains: search, mode: 'insensitive' } },
                { phone: { contains: search } },
                { email: { contains: search, mode: 'insensitive' } },
                { vatNumber: { contains: search } },
              ],
            }),
        ...(after === null
          ? {}
          : {
              OR: [
                { nameAr: { gt: after.nameAr } },
                { nameAr: after.nameAr, id: { gt: after.id } },
              ],
            }),
      },
      orderBy: [{ nameAr: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });

    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(asCustomer),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ nameAr: last.nameAr, id: last.id })
          : null,
    };
  });
}

export async function readMerchantCustomer(
  prisma: PrismaClient,
  scope: TenantScope,
  customerId: string,
): Promise<CustomerDetail | null> {
  const tenant = tenantParam(scope);
  return withTenant(prisma, scope.tenantId, async (tx) => {
    const customer: CustomerRow | null = await tx.customer.findFirst({
      where: { tenantId: tenant, id: customerId },
    });
    if (customer === null) return null;

    const [salesCount, recent] = await Promise.all([
      tx.sale.count({ where: { tenantId: tenant, customerId } }),
      tx.sale.findMany({
        where: { tenantId: tenant, customerId },
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: {
          id: true,
          status: true,
          issuedAt: true,
          currency: true,
          totalMinor: true,
          invoice: { select: { invoiceNumber: true } },
        },
      }),
    ]);

    return {
      ...asCustomer(customer),
      salesCount,
      recentSales: recent.map((sale) => ({
        id: sale.id,
        invoiceNumber: sale.invoice?.invoiceNumber ?? null,
        status: sale.status,
        issuedAt: sale.issuedAt.toISOString(),
        currency: sale.currency,
        totalMinor: sale.totalMinor.toString(),
      })),
    };
  });
}

export async function createMerchantCustomer(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CustomerActor,
  request: CustomerCreateRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<CustomerMutationResult> {
  const tenant = tenantParam(scope);
  const requestHash = fingerprint({
    nameAr: request.nameAr,
    nameEn: request.nameEn,
    phone: request.phone,
    email: request.email,
    vatNumber: request.vatNumber,
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const reservation = await reserveOperation(
      tx,
      tenant,
      CREATE_SCOPE,
      request.operationId,
      requestHash,
      nextId,
    );
    if (reservation.replay !== null) return { customer: reservation.replay, replayed: true };

    await lockTenant(tx, tenant);
    if (request.phone !== null) {
      const conflict = await tx.customer.findFirst({ where: { tenantId: tenant, phone: request.phone } });
      if (conflict !== null) throw new CustomerAdminRefusedError('phone-taken');
    }

    const at = clock();
    const id = nextId();
    const row: CustomerRow = await tx.customer.create({
      data: {
        id,
        tenantId: tenant,
        nameAr: request.nameAr,
        nameEn: request.nameEn,
        phone: request.phone,
        email: request.email,
        vatNumber: request.vatNumber,
        isActive: true,
        createdAt: at,
        updatedAt: at,
      },
    });
    const customer = asCustomer(row);
    await appendAudit(
      tx,
      tenant,
      actor,
      'customer.created',
      id,
      { hasPhone: request.phone !== null, hasVatNumber: request.vatNumber !== null },
      at,
      nextId,
    );
    await completeOperation(tx, tenant, CREATE_SCOPE, request.operationId, customer, at);
    return { customer, replayed: false };
  });
}

export async function updateMerchantCustomer(
  prisma: PrismaClient,
  scope: TenantScope,
  actor: CustomerActor,
  customerId: string,
  request: CustomerUpdateRequest,
  clock: () => Date = () => new Date(),
  nextId: () => string = newId,
): Promise<CustomerMutationResult> {
  const tenant = tenantParam(scope);
  const requestHash = fingerprint({
    customerId,
    nameAr: request.nameAr ?? null,
    nameEn: request.nameEn ?? null,
    phone: request.phone ?? null,
    email: request.email ?? null,
    vatNumber: request.vatNumber ?? null,
    isActive: request.isActive ?? null,
    fields: Object.keys(request).filter((key) => key !== 'operationId').sort(),
  });

  return withTenant(prisma, scope.tenantId, async (tx) => {
    const reservation = await reserveOperation(
      tx,
      tenant,
      UPDATE_SCOPE,
      request.operationId,
      requestHash,
      nextId,
    );
    if (reservation.replay !== null) return { customer: reservation.replay, replayed: true };

    await lockTenant(tx, tenant);
    const existing = await tx.customer.findFirst({ where: { tenantId: tenant, id: customerId } });
    if (existing === null) throw new CustomerAdminRefusedError('unknown-customer');

    if (request.phone !== undefined && request.phone !== null && request.phone !== existing.phone) {
      const conflict = await tx.customer.findFirst({
        where: { tenantId: tenant, phone: request.phone, id: { not: customerId } },
      });
      if (conflict !== null) throw new CustomerAdminRefusedError('phone-taken');
    }

    const at = clock();
    const changed = await tx.customer.updateMany({
      where: { tenantId: tenant, id: customerId },
      data: {
        ...(request.nameAr === undefined ? {} : { nameAr: request.nameAr }),
        ...(request.nameEn === undefined ? {} : { nameEn: request.nameEn }),
        ...(request.phone === undefined ? {} : { phone: request.phone }),
        ...(request.email === undefined ? {} : { email: request.email }),
        ...(request.vatNumber === undefined ? {} : { vatNumber: request.vatNumber }),
        ...(request.isActive === undefined ? {} : { isActive: request.isActive }),
        updatedAt: at,
      },
    });
    if (changed.count !== 1) throw new CustomerAdminRefusedError('unknown-customer');

    const row: CustomerRow | null = await tx.customer.findFirst({
      where: { tenantId: tenant, id: customerId },
    });
    if (row === null) throw new DatabaseError('The customer just updated could not be read back.');
    const customer = asCustomer(row);
    await appendAudit(
      tx,
      tenant,
      actor,
      'customer.updated',
      customerId,
      {
        fields: Object.keys(request)
          .filter((key) => key !== 'operationId')
          .sort()
          .join(','),
      },
      at,
      nextId,
    );
    await completeOperation(tx, tenant, UPDATE_SCOPE, request.operationId, customer, at);
    return { customer, replayed: false };
  });
}
