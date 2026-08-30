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
  let next = source;

  if (!next.includes(`sql.includes('\"inventory_cost_balances\"')`)) {
    next = replaceOnce(
      next,
      'tenant fake cost balance query',
      `            if (sql.includes('\"inventory_balances\"')) {\n              return Promise.resolve([{ quantityScaled: 0n, revision: 1n }]);\n            }\n`,
      `            if (sql.includes('\"inventory_cost_balances\"')) {\n              // Strike 5C's valuation cursor is subordinate to the already\n              // locked stock row. The fake returns a synchronized zero-known\n              // pool so this file continues proving tenant binding rather than\n              // pretending to prove PostgreSQL costing behaviour.\n              return Promise.resolve([\n                {\n                  knownQuantityScaled: 0n,\n                  knownValueMinor: 0n,\n                  stockRevision: 1n,\n                  costRevision: 0n,\n                },\n              ]);\n            }\n            if (sql.includes('\"inventory_balances\"')) {\n              return Promise.resolve([{ quantityScaled: 0n, revision: 1n }]);\n            }\n`,
    );
  }

  if (!next.includes(`sql.includes("set_config('app.tenant_id'")`)) {
    next = replaceOnce(
      next,
      'tenant context instrumentation',
      `        if (model === '$executeRaw') {\n          return (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {\n            contexts.push(values[0]);\n            return Promise.resolve(1);\n          };\n        }\n`,
      `        if (model === '$executeRaw') {\n          return (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {\n            const sql = strings.join(' ');\n            // \`contexts\` means exactly RLS context establishment. Strike 5C\n            // legitimately added other parameterised UPDATEs through\n            // $executeRaw; treating the first parameter of every such write as\n            // a tenant id made this fake test its own implementation detail\n            // instead of the security property it names.\n            if (sql.includes("set_config('app.tenant_id'")) contexts.push(values[0]);\n            return Promise.resolve(1);\n          };\n        }\n`,
    );
  }

  if (!next.includes(`sql.includes('UPDATE \"inventory_balances\"')`)) {
    next = replaceOnce(
      next,
      'guarded stock update selector',
      `    const update = f.raw.find((sql) => sql.includes('\"inventory_balances\"'));\n`,
      `    // Strike 5C now locks the stock row before valuing the movement. The\n    // earlier SELECT ... FOR UPDATE is not the floor-enforcing mutation; this\n    // assertion deliberately selects the UPDATE whose predicate is the actual\n    // concurrency authority.\n    const update = f.raw.find((sql) => sql.includes('UPDATE \"inventory_balances\"'));\n`,
    );
  }

  return next;
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
