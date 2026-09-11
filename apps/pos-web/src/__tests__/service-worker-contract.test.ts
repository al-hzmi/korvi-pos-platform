import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';

const workerUrl = new URL('../../public/sw.js', import.meta.url);

async function workerSource(): Promise<string> {
  return readFile(workerUrl, 'utf8');
}

describe('Gate 41 service worker contract', () => {
  it('is valid JavaScript and bounds interception to the cashier shell plus immutable assets', async () => {
    const source = await workerSource();

    expect(() => new Script(source, { filename: 'sw.js' })).not.toThrow();
    expect(source).toContain("const SHELL_PATH = '/';");
    expect(source).toContain("const STATIC_PREFIXES = ['/_next/static/', '/brand/'];");
    expect(source).toContain("request.mode !== 'navigate'");
    expect(source).toContain("event.request.method !== 'GET'");
    expect(source).toContain('if (!isAllowedStaticUrl(url)) return;');
  });

  it('publishes a shell snapshot only after its completion marker exists', async () => {
    const source = await workerSource();
    const completionIndex = source.indexOf('await cache.put(\n      COMPLETE_KEY');
    const pointerIndex = source.indexOf('await writeMeta(nextMeta);');

    expect(completionIndex).toBeGreaterThan(0);
    expect(pointerIndex).toBeGreaterThan(completionIndex);
    expect(source).toContain('await caches.delete(cacheName);\n    throw error;');
  });

  it('keeps an active and previous snapshot for atomic deploy rollover', async () => {
    const source = await workerSource();

    expect(source).toContain('const keep = new Set([meta.active, meta.previous]');
    expect(source).toContain('for (const cacheName of [meta.active, meta.previous])');
    expect(source).toContain("const SHELL_CACHE_PREFIX = 'korvi-pos-shell-v1-';");
  });
});
