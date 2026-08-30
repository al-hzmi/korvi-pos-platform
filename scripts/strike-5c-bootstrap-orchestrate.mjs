import { readFileSync, writeFileSync } from 'node:fs';

function replaceExactlyOnce(path, label, before, after) {
  const source = readFileSync(path, 'utf8');
  if (source.includes(after)) return;
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  writeFileSync(path, source.replace(before, after));
}

// Normalize the temporary generator itself before executing it. The generated
// Prisma tagged-template expressions must contain ${...}; the generator source
// therefore escapes interpolation exactly once, never twice.
{
  const path = 'scripts/strike-5c-bootstrap-materialize.mjs';
  const source = readFileSync(path, 'utf8');
  const overEscaped = String.raw`\\\${`;
  const escapedOnce = String.raw`\\${`;
  const count = source.split(overEscaped).length - 1;
  if (count !== 8) {
    throw new Error(`bootstrap generator interpolation invariant: expected 8, found ${count}`);
  }
  writeFileSync(path, source.split(overEscaped).join(escapedOnce));
}

await import('./strike-5c-bootstrap-materialize.mjs');

// The file already imported CostingRequestError before bootstrap existed. Keep
// the generated import set unique instead of suppressing the compiler error.
{
  const path = 'packages/domain/src/costing/__tests__/costing.test.ts';
  const source = readFileSync(path, 'utf8');
  const duplicatePair = `  canonicalCostBootstrapForm,\n  CostingRequestError,\n`;
  const occurrence = source.split(`  CostingRequestError,\n`).length - 1;
  if (occurrence === 2) {
    const pairCount = source.split(duplicatePair).length - 1;
    if (pairCount !== 1) throw new Error('duplicate costing import has an unexpected shape');
    writeFileSync(path, source.replace(duplicatePair, `  canonicalCostBootstrapForm,\n`));
  } else if (occurrence !== 1) {
    throw new Error(`CostingRequestError import invariant: expected one/two, found ${occurrence}`);
  }
}

replaceExactlyOnce(
  'apps/api/src/server.ts',
  'lazy inventory service bootstrap adapter',
  `    balances: (principal, query) => resolve().balances(principal, query),\n`,
  `    balances: (principal, query) => resolve().balances(principal, query),\n    bootstrapCost: (principal, request) => resolve().bootstrapCost(principal, request),\n`,
);

replaceExactlyOnce(
  'apps/api/src/__tests__/inventory-admin-routes.test.ts',
  'recording inventory bootstrap adapter',
  `    async adjust(_principal, request: AdjustmentRequest) {\n`,
  `    async bootstrapCost(_principal, request) {\n      seen.push({ method: 'bootstrapCost', request });\n      return answer({\n        id: '018fb000-0000-7000-8000-0000000000c1',\n        branchId: request.branchId,\n        productId: request.productId,\n        valuedQuantityScaled: '1000',\n        stockRevision: '12',\n        costRevision: '1',\n        occurredAt: '2026-08-27T00:00:00.000Z',\n        replayed: false,\n      });\n    },\n    async adjust(_principal, request: AdjustmentRequest) {\n`,
);
