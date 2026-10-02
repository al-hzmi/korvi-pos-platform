import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import {
  installGracefulShutdown,
  type ShutdownRuntime,
  type ShutdownSignal,
} from '../runtime/shutdown.js';

class FakeRuntime implements ShutdownRuntime {
  private readonly listeners = new Map<ShutdownSignal, () => void>();
  public readonly exitCodes: number[] = [];

  public once(signal: ShutdownSignal, listener: () => void): void {
    this.listeners.set(signal, listener);
  }

  public removeListener(signal: ShutdownSignal, listener: () => void): void {
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
  }

  public exit(code: number): void {
    this.exitCodes.push(code);
  }

  public emit(signal: ShutdownSignal): void {
    this.listeners.get(signal)?.();
  }
}

describe('graceful API shutdown', () => {
  it('drains Fastify once and exits cleanly even when both signals arrive', async () => {
    const app = Fastify({ logger: false });
    await app.ready();
    const close = vi.spyOn(app, 'close');
    const runtime = new FakeRuntime();

    installGracefulShutdown(app, { runtime, timeoutMs: 1_000 });
    runtime.emit('SIGTERM');
    runtime.emit('SIGINT');

    await vi.waitFor(() => expect(runtime.exitCodes).toEqual([0]));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Fastify cannot complete the drain', async () => {
    const app = Fastify({ logger: false });
    await app.ready();
    vi.spyOn(app, 'close').mockRejectedValueOnce(new Error('sensitive adapter detail'));
    const runtime = new FakeRuntime();

    installGracefulShutdown(app, { runtime, timeoutMs: 1_000 });
    runtime.emit('SIGTERM');

    await vi.waitFor(() => expect(runtime.exitCodes).toEqual([1]));
  });

  it('rejects an invalid deadline before registering signal handlers', async () => {
    const app = Fastify({ logger: false });
    await app.ready();
    const runtime = new FakeRuntime();

    expect(() => installGracefulShutdown(app, { runtime, timeoutMs: 0 })).toThrow(
      /positive integer/,
    );
    await app.close();
  });
});
