import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  CHECKOUT_TIMEOUT_MS,
  createApiClient,
  INVENTORY_COMMAND_TIMEOUT_MS,
  PURCHASING_COMMAND_TIMEOUT_MS,
} from '../api';

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function stub(responses: readonly Response[]): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let index = 0;
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init: init ?? {} });
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return Promise.resolve(response ?? new Response(null, { status: 500 }));
    },
  };
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('the API client', () => {
  it('sends the session cookie and nothing else', async () => {
    const transport = stub([ok({ user: { id: 'u' } })]);
    await createApiClient(transport.fetch).me();

    const call = transport.calls[0]!;
    expect(call.url).toBe('/v1/auth/me');
    expect(call.init.credentials).toBe('same-origin');
    // No Authorization header: there is no token in JavaScript to put in one.
    expect(JSON.stringify(call.init.headers)).not.toMatch(/authorization/i);
  });

  it('posts exactly the three login fields', async () => {
    const transport = stub([ok({ user: { id: 'u' } })]);
    await createApiClient(transport.fetch).login({
      tenantSlug: 'korvi-a',
      email: 'sara@korvi-a.test',
      password: 'a-real-password-9!',
    });

    const call = transport.calls[0]!;
    expect(call.url).toBe('/v1/auth/login');
    expect(Object.keys(bodyOf(call.init)).sort()).toEqual(['email', 'password', 'tenantSlug']);
  });

  it('turns a 401 into an ApiError that says so', async () => {
    const transport = stub([ok({ error: 'unauthenticated' }, 401)]);
    const error = await createApiClient(transport.fetch)
      .me()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).unauthenticated).toBe(true);
    expect((error as ApiError).code).toBe('unauthenticated');
    expect((error as ApiError).ambiguous).toBe(false);
  });

  it('marks a request that never got an answer as ambiguous', async () => {
    const failing = vi.fn(() => Promise.reject(new TypeError('network down')));
    const error = await createApiClient(failing)
      .me()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).ambiguous).toBe(true);
    expect((error as ApiError).code).toBe('network');
  });

  it('lets an abort through untouched', async () => {
    // A cancelled search is the caller changing their mind, not an outage.
    const aborting = vi.fn(() =>
      Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
    const error = await createApiClient(aborting)
      .products({ q: 'x' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });

  it('handles the 204 that logout returns', async () => {
    const transport = stub([new Response(null, { status: 204 })]);
    await expect(createApiClient(transport.fetch).logout()).resolves.toBeUndefined();
  });

  it('bounds and encodes a product query', async () => {
    const transport = stub([ok({ products: [] })]);
    await createApiClient(transport.fetch).products({ q: 'حليب طازج', limit: 20 });
    expect(transport.calls[0]!.url).toBe(
      '/v1/products?q=%D8%AD%D9%84%D9%8A%D8%A8+%D8%B7%D8%A7%D8%B2%D8%AC&limit=20',
    );
  });

  it('gives up on a checkout that is never answered, and calls it ambiguous', async () => {
    // Deliberately not an AbortError. A cancelled search means nothing
    // happened; a checkout that timed out may already have committed, and the
    // two must not share a classification.
    vi.useFakeTimers();
    try {
      const hung = (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });

      const attempt = createApiClient(hung).checkout({
        operationId: 'op-1',
        terminalId: 'tm-1',
        cashReceivedMinor: '5000',
        lines: [{ productId: 'p-1', quantityScaled: '1000' }],
      });
      const caught = attempt.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(CHECKOUT_TIMEOUT_MS + 1);
      const error = await caught;

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('timeout');
      expect((error as ApiError).ambiguous).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not time out a checkout that answers in time', async () => {
    vi.useFakeTimers();
    try {
      const transport = stub([ok({ sale: { saleId: 's1' }, replayed: false }, 201)]);
      const response = await createApiClient(transport.fetch).checkout({
        operationId: 'op-1',
        terminalId: 'tm-1',
        cashReceivedMinor: '5000',
        lines: [{ productId: 'p-1', quantityScaled: '1000' }],
      });
      expect(response.replayed).toBe(false);
      // The timer must be cleared, or the next tick aborts a settled request.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies an unanswered stock command as ambiguous', async () => {
    vi.useFakeTimers();
    try {
      const hung = (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      const attempt = createApiClient(hung).inventoryAdjust({
        operationId: 'stock-op-1',
        branchId: 'branch-1',
        reason: 'تلف',
        lines: [{ productId: 'product-1', deltaQuantityScaled: '-1000' }],
      });
      const caught = attempt.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(INVENTORY_COMMAND_TIMEOUT_MS + 1);
      const error = await caught;
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('timeout');
      expect((error as ApiError).ambiguous).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies an unanswered cost bootstrap as ambiguous', async () => {
    vi.useFakeTimers();
    try {
      const hung = (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      const attempt = createApiClient(hung).inventoryCostBootstrap({
        operationId: 'cost-op-1',
        branchId: 'branch-1',
        productId: 'product-1',
        totalValueMinor: '9007199254740993',
        expectedStockRevision: '12',
        expectedCostRevision: '8',
        expectedUnknownPositiveQuantityScaled: '3000',
      });
      const caught = attempt.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(INVENTORY_COMMAND_TIMEOUT_MS + 1);
      const error = await caught;
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('timeout');
      expect((error as ApiError).ambiguous).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('classifies an unanswered purchase receipt as ambiguous', async () => {
    vi.useFakeTimers();
    try {
      const hung = (_url: string, init?: RequestInit): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      const attempt = createApiClient(hung).receivePurchaseOrder({
        operationId: 'receipt-op-1',
        purchaseOrderId: 'order-1',
        reference: null,
        lines: [{ purchaseOrderLineId: 'line-1', acceptedQuantityScaled: '1000' }],
      });
      const caught = attempt.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(PURCHASING_COMMAND_TIMEOUT_MS + 1);
      const error = await caught;
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('timeout');
      expect((error as ApiError).ambiguous).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends restaurant transfer and cancellation as bounded retryable commands', async () => {
    const order = {
      id: '018f2000-0000-7000-8000-000000000201',
      status: 'open',
      revision: '8',
      lines: [],
    };
    const transport = stub([ok({ order, replayed: false }), ok({ order, replayed: false })]);
    const api = createApiClient(transport.fetch);

    await api.transferRestaurantOrderTable(order.id, {
      operationId: '018f2000-0000-7000-8000-000000000202',
      expectedRevision: '7',
      tableId: '018f2000-0000-7000-8000-000000000203',
    });
    await api.cancelRestaurantOrder(order.id, {
      operationId: '018f2000-0000-7000-8000-000000000204',
      expectedRevision: '8',
      reason: 'طلب العميل الإلغاء',
    });

    expect(transport.calls[0]!.url).toBe(`/v1/restaurant/orders/${order.id}/transfer-table`);
    expect(bodyOf(transport.calls[0]!.init)).toEqual({
      operationId: '018f2000-0000-7000-8000-000000000202',
      expectedRevision: '7',
      tableId: '018f2000-0000-7000-8000-000000000203',
    });
    expect(transport.calls[1]!.url).toBe(`/v1/restaurant/orders/${order.id}/cancel`);
    expect(bodyOf(transport.calls[1]!.init)).toEqual({
      operationId: '018f2000-0000-7000-8000-000000000204',
      expectedRevision: '8',
      reason: 'طلب العميل الإلغاء',
    });
  });

  it('uses non-fiscal KDS endpoints with exact task revision commands', async () => {
    const stationId = '018f3000-0000-7000-8000-000000000201';
    const taskId = '018f3000-0000-7000-8000-000000000202';
    const station = {
      id: stationId,
      branchId: '018f3000-0000-7000-8000-000000000203',
      code: 'BAR',
      nameAr: 'البار',
      sortOrder: 1,
      isActive: true,
    };
    const task = {
      id: taskId,
      branchId: station.branchId,
      stationId,
      orderId: '018f3000-0000-7000-8000-000000000204',
      orderLineId: '018f3000-0000-7000-8000-000000000205',
      productId: '018f3000-0000-7000-8000-000000000206',
      orderRevision: '3',
      lineNumber: 1,
      sku: 'COF-1',
      nameAr: 'قهوة',
      quantityScaled: '1000',
      preparationNote: null,
      preparationOptions: null,
      status: 'queued',
      revision: '1',
      queuedAt: '2026-09-20T11:00:00.000Z',
      startedAt: null,
      readyAt: null,
      servedAt: null,
    };
    const transport = stub([
      ok({
        value: {
          orderId: task.orderId,
          orderRevision: task.orderRevision,
          alreadyFired: false,
          tasks: [task],
        },
        replayed: false,
      }),
      ok([station]),
      ok([task]),
      ok({ value: { ...task, status: 'preparing', revision: '2' }, replayed: false }),
    ]);
    const api = createApiClient(transport.fetch);

    await api.fireRestaurantPreparation(task.orderId, {
      operationId: '018f3000-0000-7000-8000-000000000207',
      expectedOrderRevision: '3',
    });
    await api.restaurantPreparationStations();
    await api.restaurantPreparationTasks(stationId);
    await api.updateRestaurantPreparationTask(taskId, {
      operationId: '018f3000-0000-7000-8000-000000000208',
      expectedRevision: '1',
      status: 'preparing',
    });

    expect(transport.calls.map((call) => call.url)).toEqual([
      `/v1/restaurant/orders/${task.orderId}/preparation/fire`,
      '/v1/restaurant/preparation-stations',
      `/v1/restaurant/preparation-stations/${stationId}/tasks`,
      `/v1/restaurant/preparation-tasks/${taskId}/status`,
    ]);
    expect(bodyOf(transport.calls[0]!.init)).toEqual({
      operationId: '018f3000-0000-7000-8000-000000000207',
      expectedOrderRevision: '3',
    });
    expect(bodyOf(transport.calls[3]!.init)).toEqual({
      operationId: '018f3000-0000-7000-8000-000000000208',
      expectedRevision: '1',
      status: 'preparing',
    });
  });

  it('posts a return without client-authored monetary truth', async () => {
    const saleId = '018f4000-0000-7000-8000-000000000201';
    const saleLineId = '018f4000-0000-7000-8000-000000000202';
    const terminalId = '018f4000-0000-7000-8000-000000000203';
    const transport = stub([
      ok({
        sales: [
          {
            saleId,
            invoiceNumber: 'INV-1',
            sequence: 1,
            issuedAt: '2026-09-22T18:00:00.000Z',
            currency: 'SAR',
            totalMinor: '1000',
            refundedTotalMinor: '0',
            fullyReturned: false,
          },
        ],
        limit: 10,
      }),
      ok({
        sale: {
          saleId,
          invoiceNumber: 'INV-1',
          issuedAt: '2026-09-22T18:00:00.000Z',
          currency: 'SAR',
          netMinor: '870',
          vatMinor: '130',
          totalMinor: '1000',
          refundedTotalMinor: '0',
          lines: [],
        },
      }),
      ok({
        return: {
          returnId: '018f4000-0000-7000-8000-000000000204',
          returnNumber: 'RET-1',
          saleId,
          operationId: '018f4000-0000-7000-8000-000000000205',
          sequence: 1,
          branchId: '018f4000-0000-7000-8000-000000000206',
          terminalId,
          shiftId: '018f4000-0000-7000-8000-000000000207',
          currency: 'SAR',
          reason: 'تالف',
          grossMinor: '1000',
          lineDiscountMinor: '0',
          basketDiscountMinor: '0',
          netMinor: '870',
          vatMinor: '130',
          totalMinor: '1000',
          issuedAt: '2026-09-22T18:10:00.000Z',
          lines: [],
          refund: { kind: 'cash', scheme: null, amountMinor: '1000', reference: null },
        },
        replayed: false,
      }),
    ]);
    const api = createApiClient(transport.fetch);

    await api.saleLookup('INV-1');
    await api.returnableSale(saleId);
    await api.createReturn({
      operationId: '018f4000-0000-7000-8000-000000000205',
      terminalId,
      saleId,
      reason: '  تالف  ',
      refund: { kind: 'cash' },
      lines: [{ saleLineId, quantityScaled: '1000' }],
    });

    expect(transport.calls.map((call) => call.url)).toEqual([
      '/v1/sales/lookup?q=INV-1&limit=10',
      `/v1/sales/${saleId}/returnable`,
      '/v1/returns',
    ]);
    const body = bodyOf(transport.calls[2]!.init);
    expect(body).toEqual({
      operationId: '018f4000-0000-7000-8000-000000000205',
      terminalId,
      saleId,
      reason: 'تالف',
      refund: { kind: 'cash' },
      lines: [{ saleLineId, quantityScaled: '1000' }],
    });
    expect(JSON.stringify(body)).not.toMatch(
      /refundTotal|totalMinor|netMinor|vatMinor|shiftId|branchId|expectedCash|variance/i,
    );
  });

  it('closes a shift with only the blind physical count as client monetary input', async () => {
    const terminalId = '018f5000-0000-7000-8000-000000000201';
    const shiftId = '018f5000-0000-7000-8000-000000000202';
    const transport = stub([
      ok({
        shift: {
          shiftId,
          branchId: '018f5000-0000-7000-8000-000000000203',
          terminalId,
          openedByUserId: '018f5000-0000-7000-8000-000000000204',
          closedByUserId: '018f5000-0000-7000-8000-000000000204',
          status: 'closed',
          openedAt: '2026-09-22T08:00:00.000Z',
          closedAt: '2026-09-22T18:00:00.000Z',
          reconciliation: {
            openingFloatMinor: '10000',
            cashSalesMinor: '50000',
            cashRefundsMinor: '5000',
            paidInMinor: '0',
            paidOutMinor: '0',
            expectedCashMinor: '55000',
            declaredCashMinor: '54900',
            varianceMinor: '-100',
          },
        },
        replayed: false,
      }),
    ]);
    const api = createApiClient(transport.fetch);

    await api.closeShift({
      operationId: '018f5000-0000-7000-8000-000000000205',
      terminalId,
      shiftId,
      declaredCashMinor: '54900',
    });

    expect(transport.calls[0]!.url).toBe('/v1/shifts/close');
    const body = bodyOf(transport.calls[0]!.init);
    expect(body).toEqual({
      operationId: '018f5000-0000-7000-8000-000000000205',
      terminalId,
      shiftId,
      declaredCashMinor: '54900',
    });
    expect(JSON.stringify(body)).not.toMatch(
      /expectedCashMinor|varianceMinor|cashSalesMinor|cashRefundsMinor|paidInMinor|paidOutMinor/,
    );
  });

  it('reads a null shift as no open shift', async () => {
    const transport = stub([ok({ shift: null })]);
    const shift = await createApiClient(transport.fetch).currentShift(
      '018f2000-0000-7000-8000-0000000000a2',
    );
    expect(shift).toBeNull();
  });
});
