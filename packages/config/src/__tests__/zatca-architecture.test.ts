import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static assertions over the ZATCA architecture documentation.
 *
 * Compliance documentation is load-bearing: an engineer implementing Phase 2
 * will build what it describes. Revision 2 stated that tag 9 belonged to
 * standard invoices, which is wrong, and left the impression that signing could
 * follow issuance. Both are the kind of error that produces documents which
 * were never compliant at the moment they were handed over.
 *
 * These tests pin the corrected statements so they cannot silently regress.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../../..');
const doc = readFileSync(join(root, 'docs/architecture/zatca.md'), 'utf8');
const tlv = readFileSync(join(root, 'packages/domain/src/zatca/tlv.ts'), 'utf8');

describe('Phase 2 simplified tax invoice QR', () => {
  it('is documented as carrying tags 1 to 9', () => {
    expect(doc).toContain('tags 1-9');
    expect(doc).toMatch(/simplified tax invoice QR carries tags 1-9/i);
  });

  it('documents every tag from 6 to 9', () => {
    for (const row of [
      /\|\s*6\s*\|.*hash/i,
      /\|\s*7\s*\|.*signature|stamp/i,
      /\|\s*8\s*\|.*public key/i,
      /\|\s*9\s*\|.*(technical CA|CA signature)/i,
    ]) {
      expect(doc).toMatch(row);
    }
  });

  it('attributes tag 9 to simplified invoices, not standard ones', () => {
    expect(doc).toMatch(/[Tt]ag 9[^.]*simplified/);
    expect(doc).not.toMatch(/[Tt]ag 9[^.]*[Ss]tandard invoices only/);
    expect(doc).not.toMatch(/Standard invoices only, returned by clearance/);
  });

  it('says the same thing in the TLV module', () => {
    expect(tlv).toContain('tags 1-9');
    expect(tlv).toMatch(/technical\s*\n?\s*\*?\s*CA signature|CA signature over that public key/i);
  });
});

describe('local issuance ordering', () => {
  const pipeline = [
    'deterministic sale totals',
    'compliant UBL XML',
    'canonicalisation',
    'invoice hash',
    'cryptographic stamping',
    'QR carrying tags 1-9',
    'immutable local persistence',
    'customer invoice / receipt issuance',
  ];

  it('documents the pipeline in order', () => {
    let cursor = -1;
    for (const step of pipeline) {
      const index = doc.indexOf(step);
      expect(index, `"${step}" missing from the documented pipeline`).toBeGreaterThan(-1);
      expect(index, `"${step}" is out of order`).toBeGreaterThan(cursor);
      cursor = index;
    }
  });

  it('places signing before the customer receives the document', () => {
    // The ordering constraint that matters: a receipt handed over must already
    // carry its stamp and its complete QR.
    const signing = doc.indexOf('cryptographic stamping');
    const issuance = doc.indexOf('customer invoice / receipt issuance');
    expect(signing).toBeGreaterThan(-1);
    expect(issuance).toBeGreaterThan(signing);
    expect(doc).toMatch(/[Ss]igning is not deferred past issuance/);
  });

  it('places reporting after issuance and allows it to be retried', () => {
    const issuance = doc.indexOf('customer invoice / receipt issuance');
    const reporting = doc.indexOf('reporting -> FATOORA API');
    expect(reporting).toBeGreaterThan(issuance);
    expect(doc).toMatch(/regulatory window/);
  });

  it('scopes the offline queue to reporting, not signing', () => {
    // Prettier normalises markdown emphasis to underscores.
    expect(doc).toMatch(/queue in ADR-0005 models [*_]reporting[*_], not signing/);
  });
});

describe('no invented policy', () => {
  it('does not assert what a till does when its certificate expires', () => {
    // Removed in revision 3: that behaviour is a regulatory question, and this
    // repository is not a source of ZATCA policy.
    const corpus = [
      doc,
      readFileSync(join(root, 'docs/decisions/ADR-0005-offline-first.md'), 'utf8'),
    ];
    for (const text of corpus) {
      expect(text).not.toMatch(/certificate expires mid-shift must keep selling/i);
    }
  });

  it('directs the reader to the official specifications', () => {
    expect(doc).toMatch(/official ZATCA (e-invoicing )?specifications/i);
  });

  it('states plainly that tags 1-5 alone are not Phase 2 compliance', () => {
    expect(doc).toMatch(/not Phase 2 compliance/i);
    expect(tlv).toMatch(/NOT ZATCA Phase 2 compliance/);
  });
});
