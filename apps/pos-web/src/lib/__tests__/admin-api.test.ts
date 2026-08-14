import { describe, expect, it } from 'vitest';
import { createApiClient } from '../api';

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function transport(body: unknown = {}): {
  readonly calls: Recorded[];
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

function bodyOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('merchant administration API client', () => {
  it('uses the authenticated admin settings route and PATCHes only editable fields', async () => {
    const wire = transport({});
    const api = createApiClient(wire.fetch);

    await api.updateAdminSettings({
      requireBarcode: true,
      receiptFooterAr: null,
    });

    const call = wire.calls[0]!;
    expect(call.url).toBe('/v1/admin/settings');
    expect(call.init.method).toBe('PATCH');
    expect(call.init.credentials).toBe('same-origin');
    expect(bodyOf(call)).toEqual({ requireBarcode: true, receiptFooterAr: null });
    expect(JSON.stringify(bodyOf(call))).not.toMatch(/tenantId|permissions|role|currency|priceMode/);
  });

  it('encodes keyset paging without inventing tenant scope', async () => {
    const wire = transport({ items: [], hasMore: false, nextCursor: null });
    await createApiClient(wire.fetch).adminBranches({ limit: 25, cursor: 'فرع/2' });

    expect(wire.calls[0]!.url).toBe(
      '/v1/admin/branches?limit=25&cursor=%D9%81%D8%B1%D8%B9%2F2',
    );
    expect(wire.calls[0]!.url).not.toContain('tenant');
  });

  it('scopes a terminal list by branch only when the caller asks for that filter', async () => {
    const wire = transport({ items: [], hasMore: false, nextCursor: null });
    await createApiClient(wire.fetch).adminTerminals({
      limit: 50,
      branchId: '018fb000-0000-7000-8000-0000000000a1',
      cursor: 'T-04',
    });

    expect(wire.calls[0]!.url).toBe(
      '/v1/admin/terminals?limit=50&cursor=T-04&branchId=018fb000-0000-7000-8000-0000000000a1',
    );
  });

  it('creates a branch from named merchant fields and no authority fields', async () => {
    const wire = transport({ id: 'b-1' });
    await createApiClient(wire.fetch).createAdminBranch({
      code: 'JED-1',
      nameAr: 'جدة',
      nameEn: 'Jeddah',
    });

    const call = wire.calls[0]!;
    expect(call.init.method).toBe('POST');
    expect(bodyOf(call)).toEqual({ code: 'JED-1', nameAr: 'جدة', nameEn: 'Jeddah' });
  });

  it('sends activation as a boolean and never as a client-side status label', async () => {
    const wire = transport({ id: 'b-1', isActive: false });
    await createApiClient(wire.fetch).setAdminBranchActive('branch/one', false);

    const call = wire.calls[0]!;
    expect(call.url).toBe('/v1/admin/branches/branch%2Fone/activation');
    expect(bodyOf(call)).toEqual({ isActive: false });
  });

  it('PATCHes a terminal label without sending its branch or code back as authority', async () => {
    const wire = transport({ id: 't-1' });
    await createApiClient(wire.fetch).updateAdminTerminal('t-1', 'صندوق المدخل');

    const call = wire.calls[0]!;
    expect(call.init.method).toBe('PATCH');
    expect(bodyOf(call)).toEqual({ label: 'صندوق المدخل' });
  });
});
