import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const proofUrl = new URL(
  '../../../../scripts/gate5-full-shift-offline-proof.mjs',
  import.meta.url,
);

describe('Gate 5 Chrome outage proof contract', () => {
  it('separates request outage from navigator network state on current CDP', async () => {
    const source = await readFile(proofUrl, 'utf8');

    expect(source).toContain("cdp.send('Network.emulateNetworkConditions', conditions)");
    expect(source).toContain("cdp.send('Network.overrideNetworkState', conditions)");
    expect(source).toContain("Page.navigate', { url: `${baseUrl}/cashier` }");
    expect(source).toContain('navigator.onLine === false');
  });
});
