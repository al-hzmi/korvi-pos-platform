import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createGuards } from '../../../../api/src/auth/guards.js';
import { loadConfig } from '../../../../api/src/config.js';
import { registerInventoryAdminRoutes } from '../../../../api/src/routes/inventory-admin.js';
import { ApiError, createApiClient } from '../api';
import {
  costFlightOutcomeFor,
  describeCostCommandFailure,
  executeCostCommand,
} from '../cost-command';
import { createCostCommandFlight } from '../cost-command-flight';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';
import type { AuthService } from '../../../../api/src/auth/service.js';
import type {
  MerchantInventoryService,
  StockFailureReason,
} from '../../../../api/src/inventory/service.js';
import type { ApiClient } from '../api';
import type { CostCommandFailureAction } from '../cost-command';
import type { CostCommandIntent } from '../cost-command-flight';

/**
 * Exercise the real HTTP serializer, JSON client and failure classifier together.
 * Only authentication lookup and the inventory service outcome are test doubles;
 * this is a wire-contract proof, not a PostgreSQL or browser-interaction proof.
 */
const PRINCIPAL: AuthenticatedPrincipal = {
  tenantId: '018fb000-0000-7000-8000-00000000000a',
  tenantSlug: 'korvi-a',
  userId: '018fb000-0000-7000-8000-0000000000a4',
  sessionId: '018fb000-0000-7000-8000-0000000000a7',
  email: 'manager@korvi-a.test',
  displayName: 'مدير التكلفة',
  roles: ['manager'],
  permissions: ['inventory.cost.manage'],
  maxDiscountBasisPoints: 0n,
  branchId: '018fb000-0000-7000-8000-0000000000a1',
};

const INTENT: CostCommandIntent = {
  kind: 'bootstrap',
  request: {
    operationId: 'observed-cost-decision',
    branchId: '018fb000-0000-7000-8000-0000000000a1',
    productId: '018fb000-0000-7000-8000-0000000000a5',
    totalValueMinor: '10000',
    expectedStockRevision: '20',
    expectedCostRevision: '4',
    expectedUnknownPositiveQuantityScaled: '10000',
  },
};

let app: FastifyInstance;
let api: ApiClient;
let reason: StockFailureReason;
let dropNextResponse: boolean;
let wireResponses: { readonly status: number; readonly body: unknown }[];
const bootstrapCost = vi.fn<MerchantInventoryService['bootstrapCost']>();

beforeEach(async () => {
  reason = 'cost-state-changed';
  dropNextResponse = false;
  wireResponses = [];
  bootstrapCost.mockReset();
  bootstrapCost.mockImplementation(async () => ({
    outcome: 'failure',
    reason,
    productId: INTENT.request.productId,
  }));
  const auth: AuthService = {
    authenticate: vi.fn<AuthService['authenticate']>().mockResolvedValue({
      outcome: 'success',
      principal: PRINCIPAL,
    }),
    login: vi.fn<AuthService['login']>(),
    logout: vi.fn<AuthService['logout']>(),
    logoutAll: vi.fn<AuthService['logoutAll']>(),
  };
  const service: MerchantInventoryService = {
    bootstrapCost,
    branches: vi.fn<MerchantInventoryService['branches']>(),
    balances: vi.fn<MerchantInventoryService['balances']>(),
    costBalances: vi.fn<MerchantInventoryService['costBalances']>(),
    adjust: vi.fn<MerchantInventoryService['adjust']>(),
    count: vi.fn<MerchantInventoryService['count']>(),
    transfer: vi.fn<MerchantInventoryService['transfer']>(),
  };
  app = Fastify();
  const guards = createGuards(auth, loadConfig({ NODE_ENV: 'test' }));
  app.addHook('onRequest', guards.enforceOrigin);
  registerInventoryAdminRoutes(app, { service, guards });
  await app.ready();

  // Inject only the transport. Do not manufacture or normalize an ApiError:
  // the route's response bytes must pass through createApiClient unchanged.
  api = createApiClient(async (url, init) => {
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('same-origin');
    const response = await app.inject({
      method: 'POST',
      url,
      headers: {
        origin: 'http://localhost:3000',
        cookie: 'korvi_session=contract-test-session',
        'content-type': 'application/json',
      },
      payload: typeof init?.body === 'string' ? init.body : '',
    });
    wireResponses.push({ status: response.statusCode, body: response.json<unknown>() });
    if (dropNextResponse) {
      dropNextResponse = false;
      throw new TypeError('response lost after the server answered');
    }
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(async () => {
  await app.close();
});

describe('cost-bootstrap HTTP refusal reaches the real web classifier', () => {
  it('maps a stale service refusal to HTTP 409 cost_state_changed and retires the intent', async () => {
    const flight = createCostCommandFlight();
    const frozen = flight.begin(() => INTENT);
    if (frozen === null) throw new Error('the first cost intent must start');

    const error: unknown = await executeCostCommand(api, frozen).catch(
      (failure: unknown) => failure,
    );

    expect(bootstrapCost).toHaveBeenCalledExactlyOnceWith(PRINCIPAL, INTENT.request);
    expect(wireResponses).toEqual([
      {
        status: 409,
        body: {
          error: 'cost_state_changed',
          message: expect.stringMatching(/[؀-ۿ]/),
          productId: INTENT.request.productId,
        },
      },
    ]);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'cost_state_changed' });
    const failure = describeCostCommandFailure(error);
    expect(failure.action).toBe('refresh-cost');
    expect(failure.message).toMatch(/[؀-ۿ]/);
    flight.settle(costFlightOutcomeFor(failure.action));
    expect(flight.pending()).toBeNull();
  });

  const cases: readonly [StockFailureReason, number, string, CostCommandFailureAction][] = [
    ['nothing-to-value', 409, 'nothing_to_value', 'refresh-cost'],
    ['inactive-branch', 409, 'inactive_branch', 'refresh-cost'],
    ['inactive-product', 409, 'inactive_product', 'refresh-cost'],
    ['untracked-product', 409, 'untracked_product', 'refresh-cost'],
    ['stock-changed', 409, 'stock_changed', 'refresh-cost'],
    ['unknown-branch', 404, 'unknown_branch', 'refresh-cost'],
    ['unknown-product', 404, 'unknown_product', 'refresh-cost'],
    ['idempotency-conflict', 409, 'idempotency_conflict', 'blocking'],
    ['invalid-money', 422, 'invalid_money', 'edit-command'],
  ];

  it.each(cases)('classifies the route response for %s', async (refusal, status, code, action) => {
    reason = refusal;
    const error: unknown = await executeCostCommand(api, INTENT).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status, code });
    expect(describeCostCommandFailure(error)).toMatchObject({ code, action });
    expect(bootstrapCost).toHaveBeenCalledExactlyOnceWith(PRINCIPAL, INTENT.request);
  });

  it('keeps frozen observations across a lost response, then refreshes on the received refusal', async () => {
    const flight = createCostCommandFlight();
    const frozen = flight.begin(() => INTENT);
    if (frozen === null) throw new Error('the first cost intent must start');
    dropNextResponse = true;

    const lost: unknown = await executeCostCommand(api, frozen).catch(
      (failure: unknown) => failure,
    );
    const ambiguous = describeCostCommandFailure(lost);
    expect(ambiguous.action).toBe('retry-same');
    flight.settle(costFlightOutcomeFor(ambiguous.action));
    expect(flight.pending()).toBe(frozen);

    const rebuild = vi.fn(() => INTENT);
    const retry = flight.begin(rebuild);
    expect(rebuild).not.toHaveBeenCalled();
    expect(retry).toBe(frozen);
    if (retry === null) throw new Error('the frozen retry must start');
    const error: unknown = await executeCostCommand(api, retry).catch(
      (failure: unknown) => failure,
    );
    expect(bootstrapCost).toHaveBeenCalledTimes(2);
    expect(bootstrapCost).toHaveBeenNthCalledWith(1, PRINCIPAL, INTENT.request);
    expect(bootstrapCost).toHaveBeenNthCalledWith(2, PRINCIPAL, INTENT.request);
    expect(wireResponses[1]).toEqual(wireResponses[0]);
    expect(describeCostCommandFailure(error).action).toBe('refresh-cost');
    flight.settle(costFlightOutcomeFor(describeCostCommandFailure(error).action));
    expect(flight.pending()).toBeNull();
  });
});
