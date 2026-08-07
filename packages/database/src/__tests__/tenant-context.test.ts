import { describe, expect, it, vi } from 'vitest';
import { withTenant, withoutTenant } from '../tenant-context.js';
import { TenantContextError } from '../errors.js';
import type { PrismaClient } from '../client.js';

/**
 * A stand-in for Prisma that records what would reach the database.
 *
 * Enough to prove the context is established on the transaction's own
 * connection, before any work runs, without needing Postgres.
 */
function fakePrisma(): { client: PrismaClient; calls: string[]; values: unknown[] } {
  const calls: string[] = [];
  const values: unknown[] = [];

  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...args: unknown[]) => {
      calls.push(strings.join('?'));
      values.push(...args);
      return Promise.resolve(1);
    },
  };

  const client = {
    $transaction: (work: (t: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;

  return { client, calls, values };
}

describe('withTenant', () => {
  it('sets the tenant context before running the work', async () => {
    const { client, calls } = fakePrisma();
    const order: string[] = [];

    await withTenant(client, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', async () => {
      order.push('work');
      return null;
    });

    expect(calls[0]).toContain('set_config');
    expect(calls[0]).toContain('app.tenant_id');
    expect(order).toEqual(['work']);
  });

  it('binds the tenant id as a parameter rather than interpolating it', async () => {
    const { client, calls, values } = fakePrisma();
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

    await withTenant(client, id, async () => null);

    expect(values).toContain(id);
    expect(calls[0]).not.toContain(id); // never concatenated into the SQL text
  });

  it('marks the setting local so it dies with the transaction', async () => {
    const { client, calls } = fakePrisma();
    await withTenant(client, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', async () => null);
    // is_local = TRUE is what stops a pooled connection carrying the context
    // into the next tenant's request.
    expect(calls[0]).toContain('TRUE');
  });

  it('returns the work result', async () => {
    const { client } = fakePrisma();
    const result = await withTenant(
      client,
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      async () => 'value',
    );
    expect(result).toBe('value');
  });

  it('refuses a malformed tenant id', async () => {
    const { client } = fakePrisma();
    const work = vi.fn();

    await expect(withTenant(client, 'not-a-uuid', work)).rejects.toThrow(TenantContextError);
    await expect(withTenant(client, '', work)).rejects.toThrow(TenantContextError);
    await expect(withTenant(client, "'; DROP TABLE products; --", work)).rejects.toThrow(
      TenantContextError,
    );
    expect(work).not.toHaveBeenCalled();
  });

  it('propagates a failure so the transaction rolls back', async () => {
    const { client } = fakePrisma();
    await expect(
      withTenant(client, '3f2504e0-4f89-41d3-9a0c-0305e82c3301', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('withoutTenant', () => {
  it('clears the context rather than leaving the previous one in place', async () => {
    const { client, calls } = fakePrisma();
    await withoutTenant(client, async () => null);
    // The empty value is a constant in the statement, not a bound parameter —
    // there is no user input to bind here.
    expect(calls[0]).toContain("set_config('app.tenant_id', '', TRUE)");
  });

  it('still runs inside a transaction so the clear is scoped', async () => {
    const { client, calls } = fakePrisma();
    await withoutTenant(client, async () => null);
    expect(calls).toHaveLength(1);
  });
});
