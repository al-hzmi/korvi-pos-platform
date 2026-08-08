import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static verification of the SaaS schema and its tenancy boundary.
 *
 * These assertions run without a database on purpose, and they do not claim to
 * prove that PostgreSQL blocks a cross-tenant read at runtime — that needs a
 * live server and belongs in an integration suite. What they prove is narrower
 * and still worth having on every push: that nobody has added a tenant-owned
 * table without protecting it, and that every policy is written the way it has
 * to be written to work.
 *
 * The tenant-owned table list is *derived from the schema*, not hand-written.
 * A hand-written list is exactly the thing that goes stale the week someone
 * adds a table.
 */

const here = dirname(fileURLToPath(import.meta.url));
const prismaDir = join(here, '../../prisma');
const schema = readFileSync(join(prismaDir, 'schema.prisma'), 'utf8');
const migration = readFileSync(
  join(prismaDir, 'migrations/20260808120000_saas_foundation/migration.sql'),
  'utf8',
);

interface ParsedModel {
  readonly name: string;
  readonly table: string;
  readonly body: string;
  readonly hasTenantId: boolean;
}

function parseModels(source: string): readonly ParsedModel[] {
  const models: ParsedModel[] = [];
  for (const match of source.matchAll(/\nmodel\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const name = match[1] ?? '';
    const body = match[2] ?? '';
    const table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? name;
    models.push({ name, table, body, hasTenantId: /^\s*tenantId\s+String/m.test(body) });
  }
  return models;
}

const models = parseModels(schema);

/**
 * The two documented exceptions (ADR-0004).
 *
 * `permissions` is the application's own vocabulary — identical for every
 * tenant, derived from nobody's data. `global_catalog_items` is the national
 * barcode catalogue: shared reference data that would otherwise be duplicated
 * hundreds of thousands of times per merchant.
 */
const GLOBAL_TABLES = ['permissions', 'global_catalog_items'];

/** The tenant row is keyed on its own id; everything else carries tenantId. */
const SELF_KEYED = ['tenants'];

const tenantOwned = models.filter((model) => !GLOBAL_TABLES.includes(model.table));
const tenantOwnedTables = tenantOwned.map((model) => model.table);

describe('schema shape', () => {
  it('parses every model in the schema', () => {
    // A parser that silently matched nothing would make every test below pass.
    expect(models.length).toBeGreaterThanOrEqual(30);
  });

  it.each(
    tenantOwned.filter((model) => !SELF_KEYED.includes(model.table)).map((model) => model.name),
  )('%s carries tenantId', (name) => {
    const model = models.find((candidate) => candidate.name === name);
    expect(model?.hasTenantId).toBe(true);
  });

  it.each(GLOBAL_TABLES)('%s is global by design and carries no tenantId', (table) => {
    const model = models.find((candidate) => candidate.table === table);
    expect(model).toBeDefined();
    expect(model?.hasTenantId).toBe(false);
  });

  it('indexes tenantId first on every tenant-scoped key', () => {
    // A composite index whose leading column is not tenantId cannot serve a
    // tenant-filtered query, so the planner falls back to scanning across
    // every merchant's rows.
    for (const match of schema.matchAll(/@@(?:index|unique|id)\(\[([^\]]+)\]/g)) {
      const columns = (match[1] ?? '').split(',').map((column) => column.trim());
      if (columns.includes('tenantId')) {
        expect(columns[0]).toBe('tenantId');
      }
    }
  });
});

describe('money, quantity and rate columns', () => {
  it('declares no Float or Decimal column anywhere', () => {
    const declarations = [...schema.matchAll(/^\s{2}(\w+)\s+(Float|Decimal)\b/gm)];
    expect(declarations).toEqual([]);
  });

  it('stores every money column as BigInt minor units', () => {
    const moneyColumns = [...schema.matchAll(/^\s*(\w*[Mm]inor)\s+(\w+)/gm)];
    expect(moneyColumns.length).toBeGreaterThan(20);
    for (const column of moneyColumns) {
      expect(column[2], column[1]).toBe('BigInt');
    }
  });

  it('stores every quantity as a scaled BigInt, never a float', () => {
    // A grocery scale reads 0.125 kg. A float weight multiplied by a price in
    // halalas drifts exactly as a float price does (ADR-0002).
    const quantities = [...schema.matchAll(/^\s*(quantityScaled)\s+(\w+)/gm)];
    expect(quantities.length).toBeGreaterThanOrEqual(3);
    for (const column of quantities) {
      expect(column[2]).toBe('BigInt');
    }
  });

  it('stores every rate as an integer basis-point column', () => {
    const rates = [...schema.matchAll(/^\s*(\w*[Bb]asisPoints)\s+(\w+)/gm)];
    expect(rates.length).toBeGreaterThanOrEqual(5);
    for (const column of rates) {
      expect(column[2], column[1]).toBe('Int');
    }
  });
});

describe('row-level security', () => {
  it.each(tenantOwnedTables)('enables RLS on %s', (table) => {
    expect(migration).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  });

  it.each(tenantOwnedTables)('forces RLS on %s so the owner cannot bypass it', (table) => {
    // Without FORCE the owning role ignores every policy, and the application
    // role is very often the owner.
    expect(migration).toContain(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  });

  it.each(tenantOwnedTables)('defines an isolation policy for %s', (table) => {
    expect(migration).toMatch(new RegExp(`CREATE POLICY "\\w+" ON "${table}"`));
  });

  it('gives every policy both USING and WITH CHECK, and no table is missed', () => {
    // USING alone governs reads. Without WITH CHECK a caller could UPDATE a
    // visible row and reassign it to another tenant.
    // Split on the statement, not the phrase: the file's own commentary
    // mentions CREATE POLICY, and counting that would inflate the total.
    const policies = migration.split(/\nCREATE POLICY "/).slice(1);
    expect(policies.length).toBe(tenantOwnedTables.length);
    for (const policy of policies) {
      const body = policy.split(';')[0] ?? '';
      expect(body).toContain('USING');
      expect(body).toContain('WITH CHECK');
      expect(body).toContain('current_tenant_id()');
    }
  });

  it('recreates each policy rather than assuming it is absent', () => {
    // Phase 0 already created policies on tenants and products, and
    // PostgreSQL has no CREATE POLICY ... IF NOT EXISTS, so a bare CREATE
    // would abort this migration on any database that has run Phase 0.
    const pairs = [
      ...migration.matchAll(
        /DROP POLICY IF EXISTS "(\w+)" ON "(\w+)";\nCREATE POLICY "\1" ON "\2"/g,
      ),
    ];
    expect(pairs.length).toBe(tenantOwnedTables.length);
  });

  it('keys the tenants policy on its own id, not on a tenantId column', () => {
    expect(migration).toMatch(
      /CREATE POLICY "tenants_isolation" ON "tenants"\s+USING \("id" = current_tenant_id\(\)\)/,
    );
  });

  it.each(GLOBAL_TABLES)('leaves %s outside RLS deliberately', (table) => {
    expect(migration).not.toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    // and says why, so the omission cannot be mistaken for an oversight
    expect(migration).toContain('ADR-0004');
  });

  it('resolves tenant context from a session setting, not a literal', () => {
    expect(migration).toContain('current_tenant_id()');
    expect(migration).not.toMatch(/current_setting\('app\.tenant_id', FALSE\)/);
  });

  it('drops nothing', () => {
    // A forward-only migration that drops a table takes a merchant's history
    // with it.
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|DATABASE|SCHEMA|COLUMN)\b/i);
  });
});

describe('integrity constraints', () => {
  it('constrains every VAT column to 0..10000 basis points', () => {
    const ranges = [...migration.matchAll(/"vatBasisPoints" >= 0 AND "vatBasisPoints" <= 10000/g)];
    expect(ranges.length).toBeGreaterThanOrEqual(3);
  });

  it('makes a sale that does not balance impossible to store', () => {
    expect(migration).toContain('"netMinor" + "vatMinor" = "totalMinor"');
    expect(migration).toContain('"tenderedMinor" - "changeMinor" = "totalMinor"');
  });

  it('permits change on cash tenders only', () => {
    // A card terminal has no mechanism to hand money back.
    expect(migration).toContain(`CHECK ("changeMinor" = 0 OR "kind" = 'cash')`);
  });

  it('enforces the sign of a cash movement at the column', () => {
    expect(migration).toContain('cash_movements_sign');
  });

  it('makes a barcode unique within a tenant, never globally', () => {
    // Two merchants may legitimately stock the same EAN; a global constraint
    // would make the second one fail to onboard.
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "product_barcodes_tenantId_barcode_key" ON "product_barcodes"("tenantId", "barcode")',
    );
    expect(migration).not.toMatch(/UNIQUE INDEX "\w+" ON "product_barcodes"\("barcode"\)/);
  });

  it('makes a replayed operation collide instead of ringing up a second sale', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "idempotency_keys_tenantId_scope_operationId_key"',
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "sales_tenantId_operationId_key"');
  });

  it('gives the inventory balance a natural primary key', () => {
    // A surrogate id would allow two disagreeing balances for one product.
    expect(migration).toContain('PRIMARY KEY ("tenantId", "branchId", "productId")');
  });
});

describe('tenant-consistent foreign keys', () => {
  /**
   * RLS protects a row; it does not protect a reference. A sale owned by
   * tenant A, visible only to A, could still name a branch owned by B if the
   * foreign key pointed at branches(id) alone — that key proves the branch
   * exists and nothing more.
   *
   * The fix is structural: every tenant-owned parent carries a unique key on
   * (tenantId, id), and every child references that pair. These assertions
   * exist so a relationship added later cannot quietly go back to referencing
   * an id on its own.
   */

  /** Models with no tenant, whose children reference them by id alone. */
  const GLOBAL_MODELS = ['Permission', 'GlobalCatalogItem'];

  interface Reference {
    readonly model: string;
    readonly field: string;
    readonly target: string;
    readonly fields: string;
    readonly references: string;
  }

  const references: Reference[] = [];
  for (const model of models) {
    for (const match of model.body.matchAll(
      /^\s*(\w+)\s+(\w+)\??\s+@relation\(fields: \[([^\]]+)\], references: \[([^\]]+)\]/gm,
    )) {
      references.push({
        model: model.name,
        field: match[1] ?? '',
        target: match[2] ?? '',
        fields: (match[3] ?? '').replace(/\s+/g, ' ').trim(),
        references: (match[4] ?? '').replace(/\s+/g, ' ').trim(),
      });
    }
  }

  /** References to a tenant-owned parent that is not the Tenant row itself. */
  const tenantOwnedRefs = references.filter(
    (reference) => reference.target !== 'Tenant' && !GLOBAL_MODELS.includes(reference.target),
  );

  it('finds the relations it is meant to police', () => {
    // A parser that matched nothing would make every assertion below vacuous.
    expect(tenantOwnedRefs.length).toBeGreaterThanOrEqual(30);
  });

  it.each(tenantOwnedRefs.map((reference) => `${reference.model}.${reference.field}`))(
    '%s references its parent by (tenantId, id), not by id alone',
    (label) => {
      const reference = tenantOwnedRefs.find(
        (candidate) => `${candidate.model}.${candidate.field}` === label,
      );
      expect(reference?.references).toBe('tenantId, id');
      expect(reference?.fields.startsWith('tenantId, ')).toBe(true);
    },
  );

  it('gives every referenced parent the (tenantId, id) key the child points at', () => {
    const parents = [...new Set(tenantOwnedRefs.map((reference) => reference.target))];
    expect(parents.length).toBeGreaterThanOrEqual(10);
    for (const parent of parents) {
      const model = models.find((candidate) => candidate.name === parent);
      expect(model?.body, `${parent} has no tenant-consistency key`).toContain(
        '@@unique([tenantId, id])',
      );
    }
  });

  it('references a global parent by its own key, since it has no tenant', () => {
    const globalRefs = references.filter((reference) => GLOBAL_MODELS.includes(reference.target));
    expect(globalRefs.length).toBeGreaterThan(0);
    for (const reference of globalRefs) {
      expect(reference.references).not.toContain('tenantId');
    }
  });

  it('leaves no single-column foreign key to a tenant-owned table in the migration', () => {
    const globalTables = ['tenants', 'permissions', 'global_catalog_items'];
    const offenders = [
      ...migration.matchAll(/FOREIGN KEY \("(\w+)"\) REFERENCES "(\w+)"\("(\w+)"\)/g),
    ].filter((match) => !globalTables.includes(match[2] ?? ''));
    expect(offenders.map((match) => `${match[2]}.${match[3]}`)).toEqual([]);
  });

  it('writes every composite foreign key with tenantId leading', () => {
    const composite = [
      ...migration.matchAll(
        /FOREIGN KEY \("(\w+)", "(\w+)"\) REFERENCES "(\w+)"\("(\w+)", "(\w+)"\)/g,
      ),
    ];
    expect(composite.length).toBeGreaterThanOrEqual(30);
    for (const match of composite) {
      expect(match[1]).toBe('tenantId');
      expect(match[4]).toBe('tenantId');
      expect(match[5]).toBe('id');
    }
  });

  it('creates the unique key each composite foreign key needs as its target', () => {
    const targets = [
      ...new Set(
        [...migration.matchAll(/REFERENCES "(\w+)"\("tenantId", "id"\)/g)].map(
          (match) => match[1] ?? '',
        ),
      ),
    ];
    expect(targets.length).toBeGreaterThanOrEqual(10);
    for (const table of targets) {
      expect(migration, `${table} has no (tenantId, id) unique index`).toMatch(
        new RegExp(`CREATE UNIQUE INDEX (?:IF NOT EXISTS )?"${table}_tenantId_id_key"`),
      );
    }
  });

  it('refuses the delete rather than nulling a composite key', () => {
    // SET NULL on ("tenantId", "col") would null tenantId too, and tenantId is
    // NOT NULL. NO ACTION defers the check to end of statement, so a tenant
    // cascade still works while a dangling reference is still an error.
    const composite = migration.match(
      /FOREIGN KEY \("tenantId", "\w+"\) REFERENCES "\w+"\("tenantId", "id"\) ON DELETE (\w+(?: \w+)?)/g,
    );
    expect(composite?.length).toBeGreaterThanOrEqual(30);
    expect(migration).not.toMatch(
      /FOREIGN KEY \("tenantId", "\w+"\) REFERENCES "\w+"\("tenantId", "id"\) ON DELETE SET NULL/,
    );
  });
});

describe('sale snapshots', () => {
  const saleLine = models.find((model) => model.name === 'SaleLine');

  it.each(['sku', 'nameAr', 'unitPriceMinor', 'vatBasisPoints', 'quantityScaled'])(
    'snapshots %s onto the sale line',
    (column) => {
      // A finalized line must not read its description or price back from the
      // product: editing a product tomorrow would rewrite yesterday's invoice.
      expect(saleLine?.body).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
    },
  );

  it('keeps productId nullable so a deleted product cannot orphan a receipt', () => {
    expect(saleLine?.body).toMatch(/productId\s+String\?/);
  });

  it('snapshots the seller identity onto the invoice', () => {
    const invoice = models.find((model) => model.name === 'Invoice');
    expect(invoice?.body).toMatch(/^\s*sellerName\s/m);
    expect(invoice?.body).toMatch(/^\s*sellerVatNumber\s/m);
  });
});

describe('audit trail', () => {
  const audit = models.find((model) => model.name === 'AuditEvent');

  /** Field declarations only — the comments are allowed to say "password". */
  const fields = (audit?.body ?? '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('/'))
    .join('\n');

  it.each(['tenantId', 'actorUserId', 'eventType', 'entityType', 'occurredAt'])(
    'records %s',
    (column) => {
      expect(fields).toMatch(new RegExp(`^\\s*${column}\\s`, 'm'));
    },
  );

  it('carries no column that could hold a credential', () => {
    expect(fields).not.toMatch(/password|token|secret|apiKey/i);
  });
});
