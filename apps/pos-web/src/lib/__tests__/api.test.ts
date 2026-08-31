import { describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  CHECKOUT_TIMEOUT_MS,
  createApiClient,
  INVENTORY_COMMAND_TIMEOUT_MS,
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

  it('reads a null shift as no open shift', async () => {
    const transport = stub([ok({ shift: null })]);
    const shift = await createApiClient(transport.fetch).currentShift(
      '018f2000-0000-7000-8000-0000000000a2',
    );
    expect(shift).toBeNull();
  });
});
