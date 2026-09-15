import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const proofUrl = new URL('../../../../scripts/gate5-full-shift-offline-proof.mjs', import.meta.url);

describe('Gate 5 Chrome outage proof contract', () => {
  it('separates request outage from navigator state across renderer replacement', async () => {
    const source = await readFile(proofUrl, 'utf8');

    expect(source).toContain('Network.emulateNetworkConditionsByRule');
    expect(source).toContain('matchedNetworkConditions');
    expect(source).toContain('Network.overrideNetworkState');
    expect(source).toContain("connectionType: offline ? 'none' : 'wifi'");
    expect(source).toContain("Page.navigate', { url: `${baseUrl}/cashier` }");
    expect(source).toContain('afterNavigationBeforeReapply');
    expect(source).toContain('overrideNavigatorNetworkState(cdp, true)');
    expect(source).toContain('navigator.onLine === false');
  });
});
