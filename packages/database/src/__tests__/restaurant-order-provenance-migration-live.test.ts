import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { describe, expect, it } from 'vitest';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

const provenanceColumns = {
  inventoryQuantityScaled: 'bigint',
  packageCode: 'text',
  packageNameAr: 'text',
  packageUnitLabel: 'text',
  packageBaseQuantityScaled: 'bigint',
  priceContext: 'text',
  pricingProvenance: 'text',
  priceListCode: 'text',
  priceListRevision: 'bigint',
} as const;

describe.skipIf(url === '')('populated restaurant order line forward migration, PostgreSQL 17', () => {
  it('aligns Prisma and SQL while retaining every legacy provenance field as NULL', async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const schema = await readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
      const model = schema.match(/^model RestaurantOrderLine \{([\s\S]*?)^\}/m)?.[1];
      expect(model).toBeDefined();
      for (const [column, dataType] of Object.entries(provenanceColumns)) {
        const prismaType = dataType === 'bigint' ? 'BigInt' : 'String';
        expect(model, column).toMatch(
          new RegExp(`^\\s*${column}\\s+${prismaType}\\?\\s*$`, 'm'),
        );
      }

      // The real applied schema has the complete, nullable model; RLS remains
      // owned by the original tables and is not modified by this migration.
      const columns = Object.keys(provenanceColumns);
      const actual = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'restaurant_order_lines'
           AND column_name = ANY($1::text[])`,
        [columns],
      );
      expect(actual.rows).toHaveLength(columns.length);
      for (const row of actual.rows) {
        expect(row.data_type).toBe(
          provenanceColumns[row.column_name as keyof typeof provenanceColumns],
        );
        expect(row.is_nullable).toBe('YES');
      }

      // Rehearse the EXACT forward ALTER TABLE on a populated legacy-shaped
      // table isolated in this PostgreSQL connection's temporary schema.
      // No production or test tenant record is changed.
      await client.query('BEGIN');
      await client.query(`
        CREATE TEMP TABLE "restaurant_order_lines" (
          "id" uuid PRIMARY KEY,
          "tenantId" uuid NOT NULL,
          "quantityScaled" bigint NOT NULL,
          "baseUnitPriceMinor" bigint NOT NULL,
          "modifierTotalMinor" bigint NOT NULL
        ) ON COMMIT DROP
      `);
      await client.query(`
        INSERT INTO "restaurant_order_lines"
          ("id", "tenantId", "quantityScaled", "baseUnitPriceMinor", "modifierTotalMinor")
        VALUES (
          '01994f00-0000-7000-8000-000000000d01',
          '01994f00-0000-7000-8000-000000000d0a',
          1000, 1250, 200
        )
      `);
      const sql = await readFile(
        new URL(
          '../../prisma/migrations/20261009131000_restaurant_order_line_provenance_alignment/migration.sql',
          import.meta.url,
        ),
        'utf8',
      );
      const migrationBody = sql.replace(/\bBEGIN;\s*/, '').replace(/\bCOMMIT;\s*$/, '');
      await client.query(migrationBody);

      const preserved = await client.query<Record<string, unknown>>(
        'SELECT * FROM "restaurant_order_lines"',
      );
      expect(preserved.rows).toHaveLength(1);
      expect(preserved.rows[0]).toMatchObject({
        quantityScaled: '1000',
        baseUnitPriceMinor: '1250',
        modifierTotalMinor: '200',
      });
      for (const field of columns) {
        expect(preserved.rows[0]?.[field], field).toBeNull();
      }

      const tempColumns = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = (SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema())
           AND table_name = 'restaurant_order_lines'
           AND column_name = ANY($1::text[])`,
        [columns],
      );
      expect(tempColumns.rows).toHaveLength(columns.length);
      for (const row of tempColumns.rows) {
        expect(row.data_type).toBe(
          provenanceColumns[row.column_name as keyof typeof provenanceColumns],
        );
        expect(row.is_nullable).toBe('YES');
      }

      // New CHECK constraints reject corruption without rewriting legacy rows.
      await client.query('SAVEPOINT invalid_inventory');
      await expect(
        client.query('UPDATE "restaurant_order_lines" SET "inventoryQuantityScaled" = -1'),
      ).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT invalid_inventory');

      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end();
    }
  }, 60_000);
});
