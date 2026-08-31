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
  it('reads bounded inventory branches without borrowing settings authority', async () => {
    const wire = transport({ rows: [], nextCursor: null });
    await createApiClient(wire.fetch).inventoryBranches({
      limit: 50,
      cursor: '018fb000-0000-7000-8000-0000000000a1',
    });

    expect(wire.calls[0]!.url).toBe(
      '/v1/admin/inventory/branches?limit=50&cursor=018fb000-0000-7000-8000-0000000000a1',
    );
    expect(wire.calls[0]!.url).not.toContain('tenant');
  });

  it('reads exact balance pages with branch, limit and cursor as the only filters', async () => {
    const wire = transport({ rows: [], nextCursor: null });
    await createApiClient(wire.fetch).inventoryBalances({
      branchId: '018fb000-0000-7000-8000-0000000000a1',
      limit: 100,
      cursor: '018fb000-0000-7000-8000-0000000000a5',
    });

    expect(wire.calls[0]!.url).toBe(
      '/v1/admin/inventory/balances?limit=100&cursor=018fb000-0000-7000-8000-0000000000a5&branchId=018fb000-0000-7000-8000-0000000000a1',
    );
    expect(wire.calls[0]!.url).not.toMatch(/tenant|actor|quantity|revision/);
  });

  it('posts only adjustment intent and exact scaled text', async () => {
    const wire = transport({ id: 'adjustment-1', lines: [] });
    await createApiClient(wire.fetch).inventoryAdjust({
      operationId: 'op-adjust',
      branchId: 'branch-1',
      reason: 'تلف',
      lines: [{ productId: 'product-1', deltaQuantityScaled: '-1250' }],
    });

    expect(wire.calls[0]!.url).toBe('/v1/admin/inventory/adjustments');
    expect(bodyOf(wire.calls[0]!)).toEqual({
      operationId: 'op-adjust',
      branchId: 'branch-1',
      reason: 'تلف',
      lines: [{ productId: 'product-1', deltaQuantityScaled: '-1250' }],
    });
    expect(JSON.stringify(bodyOf(wire.calls[0]!))).not.toMatch(
      /tenant|actor|before|after|revision/,
    );
  });

  it('binds a count to the exact server revision and never sends a delta', async () => {
    const wire = transport({ id: 'count-1', lines: [] });
    await createApiClient(wire.fetch).inventoryCount({
      operationId: 'op-count',
      branchId: 'branch-1',
      reason: null,
      lines: [
        {
          productId: 'product-1',
          countedQuantityScaled: '0',
          expectedRevision: '9007199254740993',
        },
      ],
    });

    const body = bodyOf(wire.calls[0]!);
    expect(wire.calls[0]!.url).toBe('/v1/admin/inventory/counts');
    expect(body).toMatchObject({
      lines: [{ countedQuantityScaled: '0', expectedRevision: '9007199254740993' }],
    });
    expect(JSON.stringify(body)).not.toMatch(/delta|currentRevision|resultRevision/);
  });

  it('posts transfer direction and requested quantity without resulting balances', async () => {
    const wire = transport({ id: 'transfer-1', lines: [] });
    await createApiClient(wire.fetch).inventoryTransfer({
      operationId: 'op-transfer',
      fromBranchId: 'branch-1',
      toBranchId: 'branch-2',
      reason: 'إعادة توزيع',
      lines: [{ productId: 'product-1', quantityScaled: '1000' }],
    });

    expect(wire.calls[0]!.url).toBe('/v1/admin/inventory/transfers');
    expect(bodyOf(wire.calls[0]!)).toEqual({
      operationId: 'op-transfer',
      fromBranchId: 'branch-1',
      toBranchId: 'branch-2',
      reason: 'إعادة توزيع',
      lines: [{ productId: 'product-1', quantityScaled: '1000' }],
    });
  });

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
    expect(JSON.stringify(bodyOf(call))).not.toMatch(
      /tenantId|permissions|role|currency|priceMode/,
    );
  });

  it('encodes keyset paging without inventing tenant scope', async () => {
    const wire = transport({ items: [], hasMore: false, nextCursor: null });
    await createApiClient(wire.fetch).adminBranches({ limit: 25, cursor: 'فرع/2' });

    expect(wire.calls[0]!.url).toBe('/v1/admin/branches?limit=25&cursor=%D9%81%D8%B1%D8%B9%2F2');
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

  it('pages members with a keyset cursor and no tenant identity', async () => {
    const wire = transport({ items: [], hasMore: false, nextCursor: null });
    await createApiClient(wire.fetch).adminMembers({ limit: 20, cursor: 'person@example.test' });

    const call = wire.calls[0]!;
    expect(call.url).toBe('/v1/admin/members?limit=20&cursor=person%40example.test');
    expect(call.url).not.toContain('tenant');
  });

  it('creates a member without inventing credentials, roles or permissions', async () => {
    const wire = transport({ userId: 'u-1' });
    await createApiClient(wire.fetch).createAdminMember({
      email: 'new@example.test',
      displayName: 'موظف جديد',
      defaultBranchId: 'b-1',
    });

    const body = bodyOf(wire.calls[0]!);
    expect(body).toEqual({
      email: 'new@example.test',
      displayName: 'موظف جديد',
      defaultBranchId: 'b-1',
    });
    expect(JSON.stringify(body)).not.toMatch(/password|permission|roles|tenantId|actor/);
  });

  it('updates only member profile fields that the route accepts', async () => {
    const wire = transport({ userId: 'u-1' });
    await createApiClient(wire.fetch).updateAdminMember('u/1', {
      displayName: 'اسم جديد',
      defaultBranchId: null,
    });

    const call = wire.calls[0]!;
    expect(call.url).toBe('/v1/admin/members/u%2F1');
    expect(call.init.method).toBe('PATCH');
    expect(bodyOf(call)).toEqual({ displayName: 'اسم جديد', defaultBranchId: null });
  });

  it('uses distinct account and membership activation routes', async () => {
    const wire = transport({ member: {}, revokedSessions: 0 });
    const api = createApiClient(wire.fetch);
    await api.setAdminMemberUserActive('u-1', false);
    await api.setAdminMemberMembershipActive('u-1', true);

    expect(wire.calls[0]!.url).toBe('/v1/admin/members/u-1/user-activation');
    expect(bodyOf(wire.calls[0]!)).toEqual({ isActive: false });
    expect(wire.calls[1]!.url).toBe('/v1/admin/members/u-1/membership-activation');
    expect(bodyOf(wire.calls[1]!)).toEqual({ isActive: true });
  });

  it('grants a role by role id only and removes it with DELETE', async () => {
    const wire = transport({ member: {}, changed: true });
    const api = createApiClient(wire.fetch);
    await api.assignAdminRole('u-1', 'role/owner');
    await api.removeAdminRole('u-1', 'role/owner');

    expect(wire.calls[0]!.url).toBe('/v1/admin/members/u-1/roles');
    expect(bodyOf(wire.calls[0]!)).toEqual({ roleId: 'role/owner' });
    expect(JSON.stringify(bodyOf(wire.calls[0]!))).not.toContain('permissions');

    expect(wire.calls[1]!.url).toBe('/v1/admin/members/u-1/roles/role%2Fowner');
    expect(wire.calls[1]!.init.method).toBe('DELETE');
    expect(wire.calls[1]!.init.body).toBeUndefined();
  });
});
