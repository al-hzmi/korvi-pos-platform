import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shape of the persistence ports, read from the domain's source.
 *
 * It lives in @korvi/database rather than beside the file it inspects because
 * the domain package may not touch the filesystem (ADR-0001), and that rule is
 * worth more than the convenience of co-location.
 */

const here = dirname(fileURLToPath(import.meta.url));
const portsPath = join(here, '../../../domain/src/ports/persistence.ts');
const source = readFileSync(portsPath, 'utf8');
const indexSource = readFileSync(join(here, '../index.ts'), 'utf8');

/** Method signatures declared directly inside `interface Name { ... }`. */
function methodsOf(name: string): readonly string[] {
  const block = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? '';
  return [...block.matchAll(/^ {2}(\w+)\(([\s\S]*?)\):/gm)].map(
    (match) => `${match[1] ?? ''}(${(match[2] ?? '').replace(/\s+/g, ' ').trim()}`,
  );
}

const SCOPED_PORTS = [
  'TenantRepository',
  'BranchRepository',
  'TerminalRepository',
  'ProductRepository',
  'InventoryRepository',
  'CustomerRepository',
  'ShiftRepository',
  'ShiftReconciliationRepository',
  'SaleRepository',
  'IdempotencyRepository',
  'AuditRepository',
];

describe('every repository port', () => {
  it.each(SCOPED_PORTS)('%s declares at least one method', (name) => {
    expect(methodsOf(name).length).toBeGreaterThan(0);
  });

  it.each(SCOPED_PORTS)('takes a TenantScope as the first argument of every %s method', (name) => {
    for (const signature of methodsOf(name)) {
      expect(signature, `${name}.${signature}`).toContain('scope: TenantScope');
      expect(signature.indexOf('scope: TenantScope')).toBe(signature.indexOf('(') + 1);
    }
  });

  it('exposes exactly one unscoped port, and it reads shared reference data', () => {
    const unscoped = [...source.matchAll(/interface (\w+Repository) \{([\s\S]*?)\n\}/g)].filter(
      (match) => !(match[2] ?? '').includes('scope: TenantScope'),
    );
    expect(unscoped.map((match) => match[1])).toEqual(['GlobalCatalogRepository']);
  });

  it('offers no unscoped tenant lookup', () => {
    // One added "temporarily" becomes the method every later caller reaches
    // for. The gap is deliberate; see the note in the ports file.
    expect(source).not.toMatch(/^\s*(resolve|find)\w*\(slug/m);
    expect(source).not.toMatch(/interface TenantDirectory/);
  });
});

describe('what may cross the persistence boundary', () => {
  it('carries money and quantity across as strings', () => {
    // A bigint cannot be JSON-serialised; a number loses halalas above 2^53.
    expect(source).toMatch(/readonly priceMinor: string;/);
    expect(source).toMatch(/readonly totalMinor: string;/);
    expect(source).toMatch(/readonly quantityScaled: string;/);
    expect(source).not.toMatch(/Minor: number/);
    expect(source).not.toMatch(/quantityScaled: number/);
  });

  it('carries every rate as the branded, validated type', () => {
    expect(source).toMatch(/readonly vatBasisPoints: BasisPoints;/);
    expect(source).not.toMatch(/vatBasisPoints: number/);
  });

  it('lets no ORM type across', () => {
    expect(source).not.toMatch(/from '@?prisma/);
    expect(source).not.toMatch(/\bPrisma[A-Z]/);
    expect(source).not.toMatch(/\b(Decimal|JsonValue|InputJsonValue)\b/);
  });

  it('keeps the internal stock helper off the public surface', () => {
    // applyMovementWithin takes a raw tenant string and an open transaction.
    // Exported, it would be a way to write stock into an arbitrary tenant.
    expect(indexSource).not.toMatch(/^export \{[^}]*applyMovementWithin/m);
    expect(indexSource).toMatch(/createInventoryRepository/);
  });

  it('has one close authority and no generic drawer writer', () => {
    expect(source).not.toContain('interface CloseShiftInput');
    expect(methodsOf('ShiftRepository')).not.toContainEqual(
      expect.stringMatching(/close|Movement/),
    );
    expect(
      methodsOf('ShiftReconciliationRepository').map((method) => method.split('(')[0]),
    ).toEqual(['recordManualMovement', 'reconcile']);
  });
});
