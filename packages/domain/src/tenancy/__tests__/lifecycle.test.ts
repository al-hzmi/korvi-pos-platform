import { describe, expect, it } from 'vitest';
import {
  MAX_CONTROL_PLANE_ACTOR,
  MAX_CONTROL_PLANE_OPERATION,
  MAX_LIFECYCLE_REASON,
  TENANT_LIFECYCLE_STATES,
  TENANT_TRANSITIONS,
  TenantLifecycleError,
  isAlreadyInTargetState,
  isTenantLifecycleState,
  lifecycleEventType,
  nextTenantState,
  normalizeControlPlaneActor,
  normalizeControlPlaneOperation,
  normalizeSuspensionReason,
} from '../lifecycle.js';
import type { TenantLifecycleState, TenantTransition } from '../lifecycle.js';

describe('tenant lifecycle', () => {
  it('names exactly three states', () => {
    expect([...TENANT_LIFECYCLE_STATES]).toEqual(['provisioning', 'active', 'suspended']);
  });

  it('permits exactly the three legal moves', () => {
    expect(nextTenantState('provisioning', 'activate')).toBe('active');
    expect(nextTenantState('active', 'suspend')).toBe('suspended');
    expect(nextTenantState('suspended', 'reactivate')).toBe('active');
  });

  /**
   * The whole cross product, rather than a handful of examples.
   *
   * A state machine tested by example is a state machine whose illegal moves
   * are whatever the test author thought of. Nine pairs exist; three are legal
   * and the other six must throw, and this enumerates all nine.
   */
  it('refuses every pair the table does not name', () => {
    const legal = new Set(['provisioning:activate', 'active:suspend', 'suspended:reactivate']);
    const attempted: string[] = [];

    for (const state of TENANT_LIFECYCLE_STATES) {
      for (const transition of TENANT_TRANSITIONS) {
        const pair = `${state}:${transition}`;
        attempted.push(pair);
        if (legal.has(pair)) {
          expect(() => nextTenantState(state, transition)).not.toThrow();
        } else {
          expect(() => nextTenantState(state, transition)).toThrow(TenantLifecycleError);
        }
      }
    }

    expect(attempted).toHaveLength(9);
  });

  it('never lands anywhere outside the three states', () => {
    const landings: TenantLifecycleState[] = [];
    for (const state of TENANT_LIFECYCLE_STATES) {
      for (const transition of TENANT_TRANSITIONS) {
        try {
          landings.push(nextTenantState(state, transition));
        } catch {
          // Refused, which is the other half of the guarantee and is asserted
          // exhaustively above. Nothing lands, so nothing to check here.
        }
      }
    }
    expect(landings).toHaveLength(3);
    for (const landed of landings) expect(TENANT_LIFECYCLE_STATES).toContain(landed);
  });

  it('tells a replay apart from an illegal move', () => {
    // Already active, asked to activate: a retry that has already happened.
    expect(isAlreadyInTargetState('active', 'activate')).toBe(true);
    expect(isAlreadyInTargetState('active', 'reactivate')).toBe(true);
    expect(isAlreadyInTargetState('suspended', 'suspend')).toBe(true);

    // Suspended, asked to activate: a move the machine does not have. Both
    // refuse, and the caller answers them differently.
    expect(isAlreadyInTargetState('suspended', 'activate')).toBe(false);
    expect(isAlreadyInTargetState('provisioning', 'suspend')).toBe(false);
    expect(isAlreadyInTargetState('provisioning', 'reactivate')).toBe(false);
  });

  it('narrows an arbitrary column value', () => {
    expect(isTenantLifecycleState('active')).toBe(true);
    expect(isTenantLifecycleState('provisioning')).toBe(true);
    expect(isTenantLifecycleState('suspended')).toBe(true);
    // The pre-4A vocabulary, which no longer exists.
    expect(isTenantLifecycleState('closed')).toBe(false);
    expect(isTenantLifecycleState('ACTIVE')).toBe(false);
    expect(isTenantLifecycleState('')).toBe(false);
  });

  it('gives every transition its own audit event name', () => {
    const names = TENANT_TRANSITIONS.map((transition: TenantTransition) =>
      lifecycleEventType(transition),
    );
    expect(names).toEqual(['tenant.activated', 'tenant.suspended', 'tenant.reactivated']);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('control-plane references', () => {
  it('trims an actor and refuses an empty or oversized one', () => {
    expect(normalizeControlPlaneActor('  ops:nada  ')).toBe('ops:nada');
    expect(() => normalizeControlPlaneActor('   ')).toThrow(TenantLifecycleError);
    expect(() => normalizeControlPlaneActor('')).toThrow(TenantLifecycleError);
    expect(normalizeControlPlaneActor('a'.repeat(MAX_CONTROL_PLANE_ACTOR))).toHaveLength(
      MAX_CONTROL_PLANE_ACTOR,
    );
    expect(() => normalizeControlPlaneActor('a'.repeat(MAX_CONTROL_PLANE_ACTOR + 1))).toThrow(
      TenantLifecycleError,
    );
  });

  it('trims an operation id, because a unique index would not', () => {
    // Two ids differing only by trailing space are the same retry to a human
    // and two different keys to the index that decides whether a second
    // merchant gets created.
    expect(normalizeControlPlaneOperation(' op-1 ')).toBe('op-1');
    expect(normalizeControlPlaneOperation('op-1')).toBe(normalizeControlPlaneOperation('op-1  '));
    expect(() => normalizeControlPlaneOperation('  ')).toThrow(TenantLifecycleError);
    expect(() =>
      normalizeControlPlaneOperation('a'.repeat(MAX_CONTROL_PLANE_OPERATION + 1)),
    ).toThrow(TenantLifecycleError);
  });

  it('requires a reason for a suspension and never truncates one', () => {
    expect(normalizeSuspensionReason('  unpaid invoice  ')).toBe('unpaid invoice');
    expect(() => normalizeSuspensionReason('   ')).toThrow(TenantLifecycleError);

    const atLimit = 'ب'.repeat(MAX_LIFECYCLE_REASON);
    expect(normalizeSuspensionReason(atLimit)).toBe(atLimit);
    // Refused rather than cut short: half an explanation on the row that
    // stopped a merchant trading reads like the whole one.
    expect(() => normalizeSuspensionReason('ب'.repeat(MAX_LIFECYCLE_REASON + 1))).toThrow(
      TenantLifecycleError,
    );
  });
});
