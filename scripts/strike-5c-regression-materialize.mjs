import { readFileSync, writeFileSync } from 'node:fs';

function transform(path, work) {
  const before = readFileSync(path, 'utf8');
  const after = work(before);
  if (after !== before) writeFileSync(path, after);
}

function replaceOnce(text, label, before, after) {
  const first = text.indexOf(before);
  if (first === -1) throw new Error(`5C regression anchor missing: ${label}`);
  if (text.indexOf(before, first + 1) !== -1) {
    throw new Error(`5C regression anchor is not unique: ${label}`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

transform('packages/database/src/__tests__/repository-tenancy.test.ts', (source) => {
  if (source.includes(`sql.includes('"inventory_cost_balances"')`)) return source;
  return replaceOnce(
    source,
    'tenant fake cost balance query',
    `            if (sql.includes('"inventory_balances"')) {\n              return Promise.resolve([{ quantityScaled: 0n, revision: 1n }]);\n            }\n`,
    `            if (sql.includes('"inventory_cost_balances"')) {\n              // Strike 5C's valuation cursor is subordinate to the already\n              // locked stock row. The fake returns a synchronized zero-known\n              // pool so this file continues proving tenant binding rather than\n              // pretending to prove PostgreSQL costing behaviour.\n              return Promise.resolve([\n                {\n                  knownQuantityScaled: 0n,\n                  knownValueMinor: 0n,\n                  stockRevision: 1n,\n                  costRevision: 0n,\n                },\n              ]);\n            }\n            if (sql.includes('"inventory_balances"')) {\n              return Promise.resolve([{ quantityScaled: 0n, revision: 1n }]);\n            }\n`,
  );
});

transform(
  'packages/database/prisma/migrations/20260830210000_costing_authority/migration.sql',
  (source) => {
    if (source.includes('DROP POLICY IF EXISTS "inventory_cost_balances_isolation"')) return source;
    let next = replaceOnce(
      source,
      'cost balance policy recreation',
      `ALTER TABLE "inventory_cost_balances" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "inventory_cost_balances" FORCE ROW LEVEL SECURITY;\nCREATE POLICY "inventory_cost_balances_isolation" ON "inventory_cost_balances"\n`,
      `ALTER TABLE "inventory_cost_balances" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "inventory_cost_balances" FORCE ROW LEVEL SECURITY;\nDROP POLICY IF EXISTS "inventory_cost_balances_isolation" ON "inventory_cost_balances";\nCREATE POLICY "inventory_cost_balances_isolation" ON "inventory_cost_balances"\n`,
    );
    next = replaceOnce(
      next,
      'valuation event policy recreation',
      `ALTER TABLE "inventory_valuation_events" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "inventory_valuation_events" FORCE ROW LEVEL SECURITY;\nCREATE POLICY "inventory_valuation_events_isolation" ON "inventory_valuation_events"\n`,
      `ALTER TABLE "inventory_valuation_events" ENABLE ROW LEVEL SECURITY;\nALTER TABLE "inventory_valuation_events" FORCE ROW LEVEL SECURITY;\nDROP POLICY IF EXISTS "inventory_valuation_events_isolation" ON "inventory_valuation_events";\nCREATE POLICY "inventory_valuation_events_isolation" ON "inventory_valuation_events"\n`,
    );
    return next;
  },
);
