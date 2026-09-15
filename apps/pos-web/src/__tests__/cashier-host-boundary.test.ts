import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { canOpenControlCentre } from '../lib/control-access';
import { CONTROL_ENTRIES } from '../components/control/control-nav';

const posAppUrl = new URL('../components/pos-app.tsx', import.meta.url);
const cashierScreenUrl = new URL('../components/cashier-screen.tsx', import.meta.url);
const topBarUrl = new URL('../components/top-bar.tsx', import.meta.url);
const merchantEntryUrl = new URL('../components/merchant-entry.tsx', import.meta.url);
const rootPageUrl = new URL('../app/page.tsx', import.meta.url);
const cashierPageUrl = new URL('../app/cashier/page.tsx', import.meta.url);

async function source(url: URL): Promise<string> {
  return readFile(url, 'utf8');
}

describe('installed cashier host boundary', () => {
  it('keeps reusable cashier runtime free of Next routing and Control UI modules', async () => {
    const [posApp, cashierScreen, topBar] = await Promise.all([
      source(posAppUrl),
      source(cashierScreenUrl),
      source(topBarUrl),
    ]);

    expect(posApp).not.toContain("from 'next/");
    expect(posApp).not.toContain("'/control'");
    expect(cashierScreen).not.toContain("'./control/");
    expect(topBar).not.toContain('href="/control"');
  });

  it('leaves browser routing and the Control destination with the web host', async () => {
    const [merchantEntry, rootPage, cashierPage] = await Promise.all([
      source(merchantEntryUrl),
      source(rootPageUrl),
      source(cashierPageUrl),
    ]);

    expect(merchantEntry).toContain("from 'next/navigation'");
    expect(merchantEntry).toContain("router.replace('/control')");
    expect(merchantEntry).toContain('controlCentreHref="/control"');
    expect(rootPage).toContain('<MerchantEntry />');
    expect(cashierPage).toContain('controlCentreHref="/control"');
  });

  it('keeps Control-link authorization aligned with every implemented Control section', () => {
    for (const entry of CONTROL_ENTRIES) {
      if (entry.permission === undefined) throw new Error(`missing permission for ${entry.key}`);
      expect(canOpenControlCentre([entry.permission])).toBe(true);
    }
    expect(canOpenControlCentre(['sale.create', 'shift.open'])).toBe(false);
  });
});
