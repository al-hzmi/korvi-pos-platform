import { isUuidV7, type PriceMode, type Vertical } from '@korvi/domain';
import type { Principal, ShiftSummary, TerminalSummary } from './api-types';

const STORAGE_KEY = 'korvi:offline-workspace:v1';
export const OFFLINE_WORKSPACE_LEASE_MS = 12 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export interface OfflineWorkspaceSnapshot {
  readonly principal: Principal;
  readonly terminal: TerminalSummary;
  readonly shift: ShiftSummary;
  readonly priceMode: PriceMode;
  readonly vertical?: Vertical;
  readonly enableProductImages?: boolean;
  readonly capturedAt: string;
}

export interface OfflineWorkspaceReadPolicy {
  /** Browser defaults to 12h. Installed Cashier sets null because its signed kol1 lease owns expiry. */
  readonly maxAgeMs?: number | null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function strings(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return null;
  return value as readonly string[];
}

function principal(value: unknown): Principal | null {
  const root = record(value);
  const user = record(root?.['user']);
  const tenant = record(root?.['tenant']);
  const session = record(root?.['session']);
  const roles = strings(root?.['roles']);
  const permissions = strings(root?.['permissions']);
  const branchId = root?.['branchId'];
  if (
    root === null ||
    user === null ||
    tenant === null ||
    session === null ||
    roles === null ||
    permissions === null ||
    typeof user['id'] !== 'string' ||
    !isUuidV7(user['id']) ||
    typeof user['email'] !== 'string' ||
    typeof user['displayName'] !== 'string' ||
    typeof tenant['id'] !== 'string' ||
    !isUuidV7(tenant['id']) ||
    (tenant['slug'] !== undefined && typeof tenant['slug'] !== 'string') ||
    typeof session['id'] !== 'string' ||
    !isUuidV7(session['id']) ||
    (branchId !== null && (typeof branchId !== 'string' || !isUuidV7(branchId)))
  ) {
    return null;
  }
  return {
    user: { id: user['id'], email: user['email'], displayName: user['displayName'] },
    tenant: {
      id: tenant['id'],
      ...(tenant['slug'] === undefined ? {} : { slug: tenant['slug'] as string }),
    },
    session: { id: session['id'] },
    roles,
    permissions,
    branchId: branchId as string | null,
  };
}

function terminal(value: unknown): TerminalSummary | null {
  const item = record(value);
  if (
    item === null ||
    typeof item['id'] !== 'string' ||
    !isUuidV7(item['id']) ||
    typeof item['code'] !== 'string' ||
    typeof item['label'] !== 'string' ||
    typeof item['branchId'] !== 'string' ||
    !isUuidV7(item['branchId'])
  ) {
    return null;
  }
  return {
    id: item['id'],
    code: item['code'],
    label: item['label'],
    branchId: item['branchId'],
  };
}

function shift(value: unknown): ShiftSummary | null {
  const item = record(value);
  if (
    item === null ||
    typeof item['id'] !== 'string' ||
    !isUuidV7(item['id']) ||
    typeof item['branchId'] !== 'string' ||
    !isUuidV7(item['branchId']) ||
    typeof item['terminalId'] !== 'string' ||
    !isUuidV7(item['terminalId']) ||
    typeof item['userId'] !== 'string' ||
    !isUuidV7(item['userId']) ||
    item['status'] !== 'open' ||
    typeof item['openingFloatMinor'] !== 'string' ||
    !/^\d+$/.test(item['openingFloatMinor']) ||
    typeof item['openedAt'] !== 'string' ||
    !Number.isFinite(Date.parse(item['openedAt']))
  ) {
    return null;
  }
  return {
    id: item['id'],
    branchId: item['branchId'],
    terminalId: item['terminalId'],
    userId: item['userId'],
    status: 'open',
    openingFloatMinor: item['openingFloatMinor'],
    openedAt: item['openedAt'],
  };
}

function storage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readOfflineWorkspace(
  now: Date = new Date(),
  policy: OfflineWorkspaceReadPolicy = {},
): OfflineWorkspaceSnapshot | null {
  const local = storage();
  if (local === null) return null;
  let parsed: unknown;
  try {
    const raw = local.getItem(STORAGE_KEY);
    if (raw === null) return null;
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  const item = record(parsed);
  const savedPrincipal = principal(item?.['principal']);
  const savedTerminal = terminal(item?.['terminal']);
  const savedShift = shift(item?.['shift']);
  const savedPriceMode = item?.['priceMode'];
  const savedVertical = item?.['vertical'];
  const savedEnableProductImages = item?.['enableProductImages'];
  const capturedAt = item?.['capturedAt'];
  if (
    item === null ||
    savedPrincipal === null ||
    savedTerminal === null ||
    savedShift === null ||
    (savedPriceMode !== 'tax-inclusive' && savedPriceMode !== 'tax-exclusive') ||
    typeof capturedAt !== 'string'
  ) {
    clearOfflineWorkspace();
    return null;
  }

  const captured = Date.parse(capturedAt);
  const current = now.getTime();
  const maxAgeMs = policy.maxAgeMs === undefined ? OFFLINE_WORKSPACE_LEASE_MS : policy.maxAgeMs;
  if (
    !Number.isFinite(captured) ||
    !Number.isFinite(current) ||
    captured > current + MAX_CLOCK_SKEW_MS ||
    (maxAgeMs !== null && current - captured > maxAgeMs) ||
    savedShift.terminalId !== savedTerminal.id ||
    savedShift.branchId !== savedTerminal.branchId ||
    savedShift.userId !== savedPrincipal.user.id ||
    (savedPrincipal.branchId !== null && savedPrincipal.branchId !== savedTerminal.branchId)
  ) {
    clearOfflineWorkspace();
    return null;
  }

  const vertical: Vertical =
    savedVertical === 'grocery' ||
    savedVertical === 'restaurant' ||
    savedVertical === 'pharmacy' ||
    savedVertical === 'retail'
      ? savedVertical
      : 'retail';

  return {
    principal: savedPrincipal,
    terminal: savedTerminal,
    shift: savedShift,
    priceMode: savedPriceMode,
    vertical,
    enableProductImages:
      typeof savedEnableProductImages === 'boolean' ? savedEnableProductImages : false,
    capturedAt,
  };
}

export function writeOfflineWorkspace(
  snapshot: Omit<OfflineWorkspaceSnapshot, 'capturedAt'>,
  now: Date = new Date(),
): void {
  const local = storage();
  if (local === null || !Number.isFinite(now.getTime())) return;
  const candidate: OfflineWorkspaceSnapshot = {
    ...snapshot,
    capturedAt: now.toISOString(),
  };
  try {
    local.setItem(STORAGE_KEY, JSON.stringify(candidate));
  } catch {
    // Offline operation remains fail-closed on restart if browser storage is unavailable.
  }
}

export function clearOfflineWorkspace(): void {
  const local = storage();
  if (local === null) return;
  try {
    local.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else can safely be done if the browser refuses local storage access.
  }
}
