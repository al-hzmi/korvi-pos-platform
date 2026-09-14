import { describe, expect, it } from 'vitest';
import { createPlatformApi } from '../platform-api';

const TENANT_ID = '018fb000-0000-7000-8000-00000000000a';
const NOTE_ID = '018fb000-0000-7000-8000-00000000000b';
const OPERATION_ID = '018fb000-0000-7000-8000-00000000000c';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('platform support-note web API', () => {
  it('reads the tenant-scoped support ledger with same-origin credentials', async () => {
    const calls: { readonly input: string; readonly init?: RequestInit }[] = [];
    const api = createPlatformApi(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse({
        items: [
          {
            id: NOTE_ID,
            tenantId: TENANT_ID,
            operationId: OPERATION_ID,
            actorRef: 'platform:test-support',
            body: 'متابعة داخلية',
            createdAt: '2026-09-14T12:00:00.000Z',
          },
        ],
        nextCursor: null,
      });
    });

    const page = await api.supportNotes(TENANT_ID, { limit: 50 });

    expect(page.items[0]?.body).toBe('متابعة داخلية');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/v1/platform/tenants/${TENANT_ID}/support-notes?limit=50`);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
  });

  it('posts an idempotent support command without client-supplied actor authority', async () => {
    const calls: { readonly input: string; readonly init?: RequestInit }[] = [];
    const api = createPlatformApi(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(
        {
          note: {
            id: NOTE_ID,
            tenantId: TENANT_ID,
            operationId: OPERATION_ID,
            actorRef: 'platform:test-support',
            body: 'متابعة داخلية',
            createdAt: '2026-09-14T12:00:00.000Z',
          },
          replayed: false,
        },
        201,
      );
    });

    const result = await api.createSupportNote(TENANT_ID, {
      operationId: OPERATION_ID,
      body: 'متابعة داخلية',
    });

    expect(result.replayed).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`/v1/platform/tenants/${TENANT_ID}/support-notes`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      operationId: OPERATION_ID,
      body: 'متابعة داخلية',
    });
  });
});
