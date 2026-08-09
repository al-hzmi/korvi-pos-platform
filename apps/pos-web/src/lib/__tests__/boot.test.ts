import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { describeFailure } from '../failures';
import { loadSession } from '../session';
import { createLogoutController } from '../logout';
import { chooseTerminal, loadTerminals } from '../terminal';
import { forgetTerminalId, rememberTerminalId, rememberedTerminalId } from '../device-memory';
import { loadShift, shiftNeedsRefresh } from '../shift';
import type { ApiClient } from '../api';
import type { Principal, ShiftSummary, TerminalSummary, TerminalsResponse } from '../api-types';
import type { SessionState } from '../session';

const PRINCIPAL: Principal = {
  user: { id: 'u1', email: 'sara@korvi-a.test', displayName: 'سارة' },
  tenant: { id: 't1', slug: 'korvi-a' },
  session: { id: 's1' },
  roles: ['cashier'],
  permissions: ['product.read', 'sale.create', 'shift.open'],
  branchId: 'b1',
};

const TILL: TerminalSummary = { id: 'tm1', code: '01', label: 'صندوق ١', branchId: 'b1' };
const TILL2: TerminalSummary = { id: 'tm2', code: '02', label: 'صندوق ٢', branchId: 'b1' };
const SETTINGS = { priceMode: 'tax-inclusive', currency: 'SAR' } as const;

const SHIFT: ShiftSummary = {
  id: 'sh1',
  branchId: 'b1',
  terminalId: 'tm1',
  userId: 'u1',
  status: 'open',
  openingFloatMinor: '20000',
  openedAt: '2026-08-12T06:00:00.000Z',
};

function client(overrides: Partial<ApiClient>): ApiClient {
  const unimplemented = (): never => {
    throw new Error('not part of this test');
  };
  return {
    me: unimplemented,
    login: unimplemented,
    logout: unimplemented,
    terminals: unimplemented,
    products: unimplemented,
    currentShift: unimplemented,
    openShift: unimplemented,
    checkout: unimplemented,
    ...overrides,
  } as ApiClient;
}

describe('session restoration', () => {
  it('reports the principal when the cookie is still good', async () => {
    const state = await loadSession(client({ me: () => Promise.resolve(PRINCIPAL) }));
    expect(state).toEqual({ kind: 'ready', principal: PRINCIPAL });
  });

  it('sends a 401 to the login screen, not to an error screen', async () => {
    const state = await loadSession(
      client({ me: () => Promise.reject(new ApiError(401, 'unauthenticated', null)) }),
    );
    expect(state.kind).toBe('anonymous');
  });

  it('does not log a cashier out because the network blinked', async () => {
    // The distinction that matters: "I do not know you" and "I could not ask"
    // are different answers, and only one of them means show the login form.
    const state = await loadSession(
      client({ me: () => Promise.reject(new ApiError(0, 'network', null)) }),
    );
    expect(state.kind).toBe('unavailable');
  });
});

describe('signing out', () => {
  /**
   * The session cookie is HttpOnly. Only the server can revoke it, and this
   * code cannot read it or clear it. So a logout that was not confirmed is not
   * a logout, and saying otherwise on a shared till hands the next cashier the
   * previous one's session.
   */
  function harness(logout: () => Promise<void>) {
    const states: SessionState[] = [];
    const forget = vi.fn();
    const controller = createLogoutController({ logout }, forget);
    return {
      states,
      forget,
      controller,
      run: () => {
        controller.signOut(PRINCIPAL, (state) => states.push(state));
      },
    };
  }

  it('becomes anonymous and forgets the till once the server confirms', async () => {
    const harnessed = harness(() => Promise.resolve());
    harnessed.run();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('anonymous');
    });

    expect(harnessed.states.map((state) => state.kind)).toEqual(['signing-out', 'anonymous']);
    expect(harnessed.forget).toHaveBeenCalledTimes(1);
  });

  it('refuses to claim a logout the server never confirmed', async () => {
    const harnessed = harness(() => Promise.reject(new ApiError(0, 'network', null)));
    harnessed.run();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('logout-failed');
    });

    const last = harnessed.states.at(-1);
    expect(last?.kind).toBe('logout-failed');
    // Not anonymous, and the till is not forgotten: nothing was secured, and
    // clearing it would make the failure look like a clean exit.
    expect(harnessed.states.some((state) => state.kind === 'anonymous')).toBe(false);
    expect(harnessed.forget).not.toHaveBeenCalled();
  });

  it('completes on a retry that reaches the server', async () => {
    let attempts = 0;
    const harnessed = harness(() => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new ApiError(0, 'network', null)) : Promise.resolve();
    });

    harnessed.run();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('logout-failed');
    });
    harnessed.run();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('anonymous');
    });

    expect(attempts).toBe(2);
    expect(harnessed.forget).toHaveBeenCalledTimes(1);
  });

  it('sends one request however many times the button is pressed', async () => {
    let calls = 0;
    const releases: (() => void)[] = [];
    const harnessed = harness(
      () =>
        new Promise<void>((resolve) => {
          calls += 1;
          releases.push(resolve);
        }),
    );

    harnessed.run();
    harnessed.run();
    harnessed.run();
    expect(calls).toBe(1);
    expect(harnessed.controller.running()).toBe(true);

    releases[0]?.();
    await vi.waitFor(() => {
      expect(harnessed.states.at(-1)?.kind).toBe('anonymous');
    });
    expect(calls).toBe(1);
  });
});

describe('choosing a till', () => {
  const response = (terminals: readonly TerminalSummary[]): TerminalsResponse => ({
    branchId: 'b1',
    settings: SETTINGS,
    terminals,
  });

  it('selects the only till without asking', () => {
    expect(chooseTerminal(response([TILL]), null)).toEqual({
      kind: 'chosen',
      terminal: TILL,
      settings: SETTINGS,
    });
  });

  it('asks when there is more than one', () => {
    const state = chooseTerminal(response([TILL, TILL2]), null);
    expect(state.kind).toBe('choosing');
    expect(state.kind === 'choosing' && state.terminals).toHaveLength(2);
  });

  it('honours the till this browser used last', () => {
    expect(chooseTerminal(response([TILL, TILL2]), 'tm2')).toEqual({
      kind: 'chosen',
      terminal: TILL2,
      settings: SETTINGS,
    });
  });

  it('shows the selector again once the till is forgotten', () => {
    // "Change terminal" forgets the device id and asks again. Re-reading the
    // remembered id is what used to land straight back on the same till.
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

    rememberTerminalId(TILL2.id);
    expect(chooseTerminal(response([TILL, TILL2]), rememberedTerminalId())).toEqual({
      kind: 'chosen',
      terminal: TILL2,
      settings: SETTINGS,
    });

    forgetTerminalId();
    expect(chooseTerminal(response([TILL, TILL2]), rememberedTerminalId()).kind).toBe('choosing');
    // Only device context was touched. Nothing about the session moved.
    expect([...written.keys()]).toEqual([]);
  });

  it('forgets a remembered till the server no longer offers', () => {
    // Deactivated overnight. Remembering it would only produce a 404 later.
    expect(chooseTerminal(response([TILL, TILL2]), 'tm9').kind).toBe('choosing');
  });

  it('blocks when the branch has no active till at all', () => {
    const state = chooseTerminal(response([]), null);
    expect(state.kind).toBe('blocked');
    expect(state.kind === 'blocked' && state.failure.action).toBe('blocking');
  });

  it('carries the price mode the server decided', () => {
    const state = chooseTerminal(
      {
        branchId: 'b1',
        settings: { priceMode: 'tax-exclusive', currency: 'SAR' },
        terminals: [TILL],
      },
      null,
    );
    expect(state.kind === 'chosen' && state.settings.priceMode).toBe('tax-exclusive');
  });

  it('blocks with a named reason when the principal has no branch', async () => {
    const state = await loadTerminals(
      client({ terminals: () => Promise.reject(new ApiError(409, 'branch_required', null)) }),
      null,
    );
    expect(state.kind).toBe('blocked');
    expect(state.kind === 'blocked' && state.failure.code).toBe('branch_required');
  });

  it('blocks rather than guessing when the tenant has no settings', async () => {
    const state = await loadTerminals(
      client({
        terminals: () => Promise.reject(new ApiError(409, 'tenant-misconfigured', null)),
      }),
      null,
    );
    expect(state.kind === 'blocked' && state.failure.code).toBe('tenant-misconfigured');
  });
});

describe('the shift gate', () => {
  it('goes straight through when this cashier has a shift open', async () => {
    const state = await loadShift(
      client({ currentShift: () => Promise.resolve(SHIFT) }),
      'tm1',
      'u1',
    );
    expect(state).toEqual({ kind: 'open', shift: SHIFT });
  });

  it('asks for one when there is none', async () => {
    const state = await loadShift(
      client({ currentShift: () => Promise.resolve(null) }),
      'tm1',
      'u1',
    );
    expect(state).toEqual({ kind: 'closed' });
  });

  it('refuses to enter another cashier’s drawer', async () => {
    // The server would refuse the sale after a whole basket had been built.
    // One read up front turns that into a screen instead of a queue.
    const theirs: ShiftSummary = { ...SHIFT, userId: 'u2' };
    const state = await loadShift(
      client({ currentShift: () => Promise.resolve(theirs) }),
      'tm1',
      'u1',
    );
    expect(state).toEqual({ kind: 'foreign', shift: theirs });
  });

  it.each([
    ['no-open-shift', 409],
    ['shift-invalid', 409],
  ])('sends the till back to the shift flow after %s', (code, status) => {
    // A drawer that closed under the till mid-basket. Leaving the cashier on a
    // checkout button that will never work is worse than sending them back.
    expect(shiftNeedsRefresh(describeFailure(new ApiError(status, code, null)).action)).toBe(true);
  });

  it.each([
    ['insufficient-cash', 422],
    ['insufficient-stock', 409],
  ])('does not disturb the shift for %s', (code, status) => {
    expect(shiftNeedsRefresh(describeFailure(new ApiError(status, code, null)).action)).toBe(false);
  });

  it('does not invent a shift when the read failed', async () => {
    const state = await loadShift(
      client({ currentShift: () => Promise.reject(new ApiError(0, 'network', null)) }),
      'tm1',
      'u1',
    );
    expect(state.kind).toBe('blocked');
  });
});
