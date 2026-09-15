import { describe, expect, it } from 'vitest';
import { createCustomersApi } from '../customers-api';

const CUSTOMER_ID = '018fb000-0000-7000-8000-0000000000e1';
const OPERATION_ID = '018fb000-0000-7000-8000-0000000000f1';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordedCall(input: string, init: RequestInit | undefined) {
  return init === undefined ? { input } : { input, init };
}

describe('customer web API', () => {
  it('carries search, status and opaque cursor with same-origin credentials', async () => {
    const calls: { readonly input: string; readonly init?: RequestInit }[] = [];
    const api = createCustomersApi(async (input, init) => {
      calls.push(recordedCall(input, init));
      return jsonResponse({ items: [], nextCursor: null });
    });

    await api.list({ search: 'شركة النخبة', status: 'active', cursor: 'opaque+cursor', limit: 50 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(
      '/v1/admin/customers?search=%D8%B4%D8%B1%D9%83%D8%A9+%D8%A7%D9%84%D9%86%D8%AE%D8%A8%D8%A9&status=active&cursor=opaque%2Bcursor&limit=50',
    );
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('reads the flat customer detail contract', async () => {
    const api = createCustomersApi(async () =>
      jsonResponse({
        id: CUSTOMER_ID,
        nameAr: 'شركة النخبة',
        nameEn: null,
        phone: '0500000000',
        email: null,
        vatNumber: '310111111100003',
        isActive: true,
        createdAt: '2026-09-01T08:00:00.000Z',
        updatedAt: '2026-09-14T10:00:00.000Z',
        salesCount: 2,
        recentSales: [],
      }),
    );

    const detail = await api.detail(CUSTOMER_ID);

    expect(detail.id).toBe(CUSTOMER_ID);
    expect(detail.salesCount).toBe(2);
  });

  it('posts the exact client operation id without tenant or actor authority', async () => {
    const calls: { readonly input: string; readonly init?: RequestInit }[] = [];
    const api = createCustomersApi(async (input, init) => {
      calls.push(recordedCall(input, init));
      return jsonResponse(
        {
          customer: {
            id: CUSTOMER_ID,
            nameAr: 'شركة النخبة',
            nameEn: null,
            phone: null,
            email: null,
            vatNumber: null,
            isActive: true,
            createdAt: '2026-09-14T10:00:00.000Z',
            updatedAt: '2026-09-14T10:00:00.000Z',
          },
          replayed: false,
        },
        201,
      );
    });

    await api.create({
      operationId: OPERATION_ID,
      nameAr: 'شركة النخبة',
      nameEn: null,
      phone: null,
      email: null,
      vatNumber: null,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/v1/admin/customers');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      operationId: OPERATION_ID,
      nameAr: 'شركة النخبة',
      nameEn: null,
      phone: null,
      email: null,
      vatNumber: null,
    });
  });

  it('preserves the exact operation id on update retries', async () => {
    const calls: { readonly input: string; readonly init?: RequestInit }[] = [];
    const api = createCustomersApi(async (input, init) => {
      calls.push(recordedCall(input, init));
      return jsonResponse({
        customer: {
          id: CUSTOMER_ID,
          nameAr: 'شركة النخبة',
          nameEn: null,
          phone: null,
          email: null,
          vatNumber: null,
          isActive: false,
          createdAt: '2026-09-14T10:00:00.000Z',
          updatedAt: '2026-09-14T10:01:00.000Z',
        },
        replayed: true,
      });
    });

    await api.update(CUSTOMER_ID, { operationId: OPERATION_ID, isActive: false });

    expect(calls[0]?.input).toBe(`/v1/admin/customers/${CUSTOMER_ID}`);
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      operationId: OPERATION_ID,
      isActive: false,
    });
  });
});
