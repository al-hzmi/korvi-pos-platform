import { readFileSync, writeFileSync } from 'node:fs';

const path = 'apps/api/src/__tests__/native-auth-e2e-live.test.ts';
const source = readFileSync(path, 'utf8');
const oldBlock = `    const indexes = await withTenant(prisma, tenantA.id, async (tx) =>
      tx.$queryRaw<{ indexdef: string }[]>\`
        SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND tablename = 'device_enrollments'\`,
    );
    expect(
      indexes.some(
        (row) =>
          row.indexdef.includes('UNIQUE') &&
          row.indexdef.includes('"tenantId"') &&
          row.indexdef.includes('"id"'),
      ),
    ).toBe(true);
`;
const newBlock = `    const compositeIndexes = await withTenant(prisma, tenantA.id, async (tx) =>
      tx.$queryRaw<{ indisunique: boolean; columns: string[] }[]>\`
        SELECT
          i.indisunique,
          array_agg(a.attname ORDER BY key_columns.ordinality)::text[] AS "columns"
        FROM pg_index i
        JOIN pg_class table_relation ON table_relation.oid = i.indrelid
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_columns(attnum, ordinality)
          ON TRUE
        JOIN pg_attribute a
          ON a.attrelid = table_relation.oid AND a.attnum = key_columns.attnum
        WHERE table_relation.relname = 'device_enrollments'
        GROUP BY i.indexrelid, i.indisunique\`;
    );
    expect(
      compositeIndexes.some(
        (index) =>
          index.indisunique &&
          index.columns.length === 2 &&
          index.columns[0] === 'tenantId' &&
          index.columns[1] === 'id',
      ),
    ).toBe(true);
`;

const occurrences = source.split(oldBlock).length - 1;
if (occurrences !== 1) {
  throw new Error(`refusing transform: expected one index-proof block, found ${occurrences}`);
}
writeFileSync(path, source.replace(oldBlock, newBlock));
