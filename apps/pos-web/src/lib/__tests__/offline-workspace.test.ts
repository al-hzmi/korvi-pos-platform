import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OFFLINE_WORKSPACE_LEASE_MS,
  clearOfflineWorkspace,
  readOfflineWorkspace,
  writeOfflineWorkspace,
} from '../offline-workspace';

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let storage: MemoryStorage;

const snapshot = {
  principal: {
    user: {
      id: '018fb000-0000-7000-8000-000000000001',
      email: 'cashier@offline.test',
      displayName: 'كاشير أوفلاين',
    },
    tenant: { id: '018fb000-0000-7000-8000-000000000002', slug: 'offline-tenant' },
    session: { id: '018fb000-0000-7000-8000-000000000003' },
    roles: ['cashier'],
    permissions: ['sale.create'],
    branchId: '018fb000-0000-7000-8000-000000000004',
  },
  terminal: {
    id: '018fb000-0000-7000-8000-000000000005',
    code: 'POS-01',
    label: 'صندوق 1',
    branchId: '018fb000-0000-7000-8000-000000000004',
  },
  shift: {
    id: '018fb000-0000-7000-8000-000000000006',
    branchId: '018fb000-0000-7000-8000-000000000004',
    terminalId: '018fb000-0000-7000-8000-000000000005',
    userId: '018fb000-0000-7000-8000-000000000001',
    status: 'open',
    openingFloatMinor: '10000',
    openedAt: '2026-09-15T00:00:00.000Z',
  },
  priceMode: 'tax-inclusive' as const,
};

beforeEach(() => {
  storage = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  });
});

afterEach(() => {
  if (originalStorage === undefined) {
    Reflect.deleteProperty(globalThis, 'localStorage');
  } else {
    Object.defineProperty(globalThis, 'localStorage', originalStorage);
  }
});

describe('offline workspace lease', () => {
  it('restores the exact server-proved workspace inside the bounded lease', () => {
    const capturedAt = new Date('2026-09-15T01:00:00.000Z');
    writeOfflineWorkspace(snapshot, capturedAt);

    expect(readOfflineWorkspace(new Date(capturedAt.getTime() + 60_000))).toEqual({
      ...snapshot,
      capturedAt: capturedAt.toISOString(),
    });
  });

  it('expires closed instead of reviving a stale cashier workspace', () => {
    const capturedAt = new Date('2026-09-15T01:00:00.000Z');
    writeOfflineWorkspace(snapshot, capturedAt);

    expect(
      readOfflineWorkspace(new Date(capturedAt.getTime() + OFFLINE_WORKSPACE_LEASE_MS + 1)),
    ).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('rejects a tampered branch/shift relationship', () => {
    const capturedAt = new Date('2026-09-15T01:00:00.000Z');
    writeOfflineWorkspace(snapshot, capturedAt);
    const key = storage.key(0);
    expect(key).not.toBeNull();
    const raw = JSON.parse(storage.getItem(key ?? '') ?? '{}') as Record<string, unknown>;
    raw['shift'] = {
      ...snapshot.shift,
      branchId: '018fb000-0000-7000-8000-000000000099',
    };
    storage.setItem(key ?? '', JSON.stringify(raw));

    expect(readOfflineWorkspace(new Date(capturedAt.getTime() + 1_000))).toBeNull();
    expect(storage.length).toBe(0);
  });

  it('can be explicitly erased after confirmed server logout or 401', () => {
    writeOfflineWorkspace(snapshot, new Date('2026-09-15T01:00:00.000Z'));
    expect(storage.length).toBe(1);
    clearOfflineWorkspace();
    expect(storage.length).toBe(0);
  });
});
