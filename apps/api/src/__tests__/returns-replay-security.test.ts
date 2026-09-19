import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS, tenantId as brandTenantId } from '@korvi/domain';
import { createReturnService } from '../returns/service.js';
import { fingerprintReturnIntent } from '../returns/fingerprint.js';
import type {
  AuditRepository,
  AuthenticatedPrincipal,
  IdempotencyRepository,
  ReturnRecord,
  ReturnRepository,
  ShiftRepository,
  TerminalRepository,
} from '@korvi/domain';

const TENANT = '018f6100-0000-7000-8000-00000000000a';
const BRANCH = '018f6100-0000-7000-8000-0000000000b1';
const TERMINAL = '018f6100-0000-7000-8000-0000000000c1';
const SHIFT = '018f6100-0000-7000-8000-0000000000d1';
const ORIGINAL = '018f6100-0000-7000-8000-0000000000e1';
const ATTACKER = '018f6100-0000-7000-8000-0000000000e2';
const OPERATION = '018f6100-0000-7000-8000-0000000000f1';
const SALE = '018f6100-0000-7000-8000-0000000000f2';
const SALE_LINE = '018f6100-0000-7000-8000-0000000000f3';

const principal: AuthenticatedPrincipal = {
  tenantId: TENANT,
  tenantSlug: 'security-test',
  userId: ATTACKER,
  sessionId: '018f6100-0000-7000-8000-0000000000a1',
  email: 'attacker@korvi.test',
  displayName: 'مستخدم آخر',
  roles: ['manager'],
  permissions: [...ROLE_PERMISSIONS.manager],
  maxDiscountBasisPoints: 2_000n,
  branchId: BRANCH,
};

const intent = {
  saleId: SALE,
  terminalId: TERMINAL,
  lines: [{ saleLineId: SALE_LINE, quantityScaled: '1000' }],
  refundKind: 'cash',
  refundScheme: '',
  refundReference: '',
};

const existing: ReturnRecord = {
  id: '018f6100-0000-7000-8000-0000000000aa',
  tenantId: brandTenantId(TENANT),
  saleId: SALE,
  branchId: BRANCH,
  terminalId: TERMINAL,
  shiftId: '018f6100-0000-7000-8000-0000000000ab',
  actorUserId: ORIGINAL,
  operationId: OPERATION,
  status: 'finalized',
  sequence: 7,
  returnNumber: 'RET-7',
  reason: null,
  currency: 'SAR',
  grossMinor: '1000',
  lineDiscountMinor: '0',
  basketDiscountMinor: '0',
  netMinor: '870',
  vatMinor: '130',
  totalMinor: '1000',
  issuedAt: '2026-09-18T20:00:00.000Z',
  lines: [],
  refund: null,
};

function unexpected(): Promise<never> {
  return Promise.reject(new Error('unexpected repository call'));
}

describe('return replay authorization', () => {
  it('does not let the current shift owner replay a return created by another user', async () => {
    const returns: ReturnRepository = {
      findById: async () => null,
      findByOperationId: async () => existing,
      returnableForSale: unexpected,
      lookupSales: async () => [],
      record: unexpected,
    };
    const terminals: TerminalRepository = {
      findById: async () => ({
        id: TERMINAL,
        tenantId: brandTenantId(TENANT),
        branchId: BRANCH,
        code: 'POS-01',
        label: 'POS 01',
        isActive: true,
        lastSeenAt: null,
      }),
      findByCode: unexpected,
      listForBranch: async () => [],
      markSeen: async () => undefined,
    };
    const shifts: ShiftRepository = {
      findById: async () => null,
      findOpenForTerminal: async () => ({
        id: SHIFT,
        tenantId: brandTenantId(TENANT),
        branchId: BRANCH,
        terminalId: TERMINAL,
        userId: ATTACKER,
        status: 'open',
        openingFloatMinor: '0',
        declaredCashMinor: null,
        expectedCashMinor: null,
        varianceMinor: null,
        closedByUserId: null,
        openedAt: '2026-09-18T21:00:00.000Z',
        closedAt: null,
        reconciliation: null,
        movements: [],
      }),
      findMovementById: async () => null,
      open: unexpected,
      recordManualMovement: unexpected,
      close: unexpected,
    };
    const idempotency: IdempotencyRepository = {
      find: async () => ({
        id: '018f6100-0000-7000-8000-0000000000ac',
        tenantId: brandTenantId(TENANT),
        scope: 'return',
        operationId: OPERATION,
        requestHash: fingerprintReturnIntent(intent),
        status: 'completed',
        resultType: 'return',
        resultId: existing.id,
        completedAt: existing.issuedAt,
      }),
      reserve: unexpected,
      complete: async () => undefined,
    };
    const audit: AuditRepository = {
      append: async () => undefined,
      list: async () => [],
    };

    const service = createReturnService({ returns, terminals, shifts, idempotency, audit });
    const result = await service.create({
      principal,
      operationId: OPERATION,
      terminalId: TERMINAL,
      saleId: SALE,
      lines: [{ saleLineId: SALE_LINE, quantityScaled: '1000' }],
      refund: { kind: 'cash' },
    });

    expect(result.outcome === 'failure' && result.reason).toBe('idempotency-conflict');
  });
});
