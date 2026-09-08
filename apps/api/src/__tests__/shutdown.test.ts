import { describe, expect, it, vi } from 'vitest';
import { installGracefulShutdown } from '../runtime/shutdown.js';
import type { ShutdownRuntime } from '../runtime/shutdown.js';
import type { FastifyInstance } from 'fastify';

function runtimeHarness(): {
  runtime: ShutdownRuntime;
  signals: Map<'SIGTERM' | 'SIGINT', () => void>;
  exits: number[];
  deadlines: Array<{ listener: () => void; timeoutMs: number; unref: ReturnType<typeof vi.fn> }>;
} {
  const signals = new Map<'SIGTERM' | 'SIGINT', () => void>();
  const exits: number[] = [];
  const deadlines: Array<{
    listener: () => void;
    timeoutMs: number;
    unref: ReturnType<typeof vi.fn>;
  }> = [];

  const runtime: ShutdownRuntime = {
    once: (signal, listener) => {
      signals.set(signal, listener);
    },
    exit: (code) => {
      exits.push(code);
    },
    setTimeout: (listener, timeoutMs) => {
      const unref = vi.fn();
      deadlines.push({ listener, timeoutMs, unref });
      return { unref } as unknown as NodeJS.Timeout;
    },
  };

  return { runtime, signals, exits, deadlines };
}

describe('graceful shutdown', () => {
  it('closes exactly once, drains through Fastify, and exits cleanly', async () => {
    const harness = runtimeHarness();
    const close = vi.fn().mockResolvedValue(undefined);
    const error = vi.fn();
    const app = { close, log: { error } } as unknown as Pick<FastifyInstance, 'close' | 'log'>;

    installGracefulShutdown(app, harness.runtime);

    harness.signals.get('SIGTERM')?.();
    harness.signals.get('SIGINT')?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(close).toHaveBeenCalledTimes(1);
    expect(harness.deadlines).toHaveLength(1);
    expect(harness.deadlines[0]?.timeoutMs).toBe(25_000);
    expect(harness.deadlines[0]?.unref).toHaveBeenCalledTimes(1);
    expect(harness.exits).toEqual([0]);
    expect(error).not.toHaveBeenCalled();
  });

  it('fails closed when Fastify cannot finish shutdown', async () => {
    const harness = runtimeHarness();
    const close = vi.fn().mockRejectedValue(new Error('secret-bearing-driver-detail'));
    const error = vi.fn();
    const app = { close, log: { error } } as unknown as Pick<FastifyInstance, 'close' | 'log'>;

    installGracefulShutdown(app, harness.runtime);
    harness.signals.get('SIGTERM')?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.exits).toEqual([1]);
    expect(error).toHaveBeenCalledWith('graceful shutdown failed');
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('secret-bearing-driver-detail'));
  });

  it('forces failure exit when the shutdown deadline expires', () => {
    const harness = runtimeHarness();
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const app = {
      close,
      log: { error: vi.fn() },
    } as unknown as Pick<FastifyInstance, 'close' | 'log'>;

    installGracefulShutdown(app, harness.runtime, 1234);
    harness.signals.get('SIGTERM')?.();
    harness.deadlines[0]?.listener();

    expect(close).toHaveBeenCalledTimes(1);
    expect(harness.deadlines[0]?.timeoutMs).toBe(1234);
    expect(harness.exits).toEqual([1]);
  });
});
