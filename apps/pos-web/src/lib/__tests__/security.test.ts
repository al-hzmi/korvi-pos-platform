import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../api';
import { forgetTerminalId, rememberTerminalId, rememberedTerminalId } from '../device-memory';
import type { CheckoutRequest } from '../api-types';

/**
 * The things that must never leave the browser, and the one thing that may.
 *
 * These are not style tests. Each asserts a boundary that, if it moved, would
 * hand a client authority the server spent three strikes refusing to give it.
 */

function capture(): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  last: () => RequestInit;
} {
  let seen: RequestInit = {};
  return {
    last: () => seen,
    fetch: (_url, init) => {
      seen = init ?? {};
      return Promise.resolve(
        new Response(JSON.stringify({ sale: {}, replayed: false }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

describe('the checkout payload', () => {
  it('carries ids, quantities, cash and an operation id — and nothing else', async () => {
    const transport = capture();
    await createApiClient(transport.fetch).checkout({
      operationId: '018f2000-0000-7000-8000-0000000000f1',
      terminalId: '018f2000-0000-7000-8000-0000000000a2',
      cashReceivedMinor: '5000',
      lines: [{ productId: '018f2000-0000-7000-8000-0000000000a5', quantityScaled: '2000' }],
    });

    const body = JSON.parse(String(transport.last().body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'cashReceivedMinor',
      'lines',
      'operationId',
      'terminalId',
    ]);
    const lines = body['lines'] as Record<string, unknown>[];
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(['productId', 'quantityScaled']);
  });

  it('drops anything a caller managed to attach to the request', async () => {
    // The whitelist is the control. Even if a component hands over an object
    // carrying a price, a tenant and a role, none of it is serialised.
    const polluted = {
      operationId: '018f2000-0000-7000-8000-0000000000f1',
      terminalId: '018f2000-0000-7000-8000-0000000000a2',
      cashReceivedMinor: '5000',
      lines: [
        {
          productId: '018f2000-0000-7000-8000-0000000000a5',
          quantityScaled: '2000',
          unitPriceMinor: '1',
          totalMinor: '1',
        },
      ],
      tenantId: '018f2000-0000-7000-8000-00000000000b',
      userId: '018f2000-0000-7000-8000-0000000000ff',
      branchId: '018f2000-0000-7000-8000-0000000000a1',
      roles: ['owner'],
      permissions: ['sale.void'],
      sequence: 99,
      invoiceNumber: '01-000001',
      changeMinor: '0',
    } as unknown as CheckoutRequest;

    const transport = capture();
    await createApiClient(transport.fetch).checkout(polluted);

    const serialised = String(transport.last().body);
    for (const forbidden of [
      'tenantId',
      'userId',
      'branchId',
      'roles',
      'permissions',
      'sequence',
      'invoiceNumber',
      'unitPriceMinor',
      'totalMinor',
      'changeMinor',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe('what the browser is allowed to remember', () => {
  const written = new Map<string, string>();

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => written.get(key) ?? null,
      setItem: (key: string, value: string) => {
        written.set(key, value);
      },
      removeItem: (key: string) => {
        written.delete(key);
      },
    },
  });

  afterEach(() => {
    written.clear();
  });

  it('stores a terminal id under one key and nothing else', () => {
    rememberTerminalId('018f2000-0000-7000-8000-0000000000a2');
    expect([...written.keys()]).toEqual(['korvi.pos.terminalId']);
    expect(rememberedTerminalId()).toBe('018f2000-0000-7000-8000-0000000000a2');
    // A terminal id proves nothing on its own; the server re-checks it against
    // the session's branch on every request.
    expect([...written.values()].join()).not.toMatch(/kps1\./);
    forgetTerminalId();
    expect(written.size).toBe(0);
  });

  it('survives storage being unavailable', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked by the browser');
      },
    });
    expect(rememberedTerminalId()).toBeNull();
    expect(() => {
      rememberTerminalId('x');
    }).not.toThrow();
  });
});
