import { existsSync, readFileSync, writeFileSync } from 'node:fs';

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
  const overEscaped = '\\\\${';
  const escapedOnce = '\\${';
  const overEscapedCount = source.split(overEscaped).length - 1;
  if (overEscapedCount === 8) {
    writeFileSync(path, source.split(overEscaped).join(escapedOnce));
  } else if (overEscapedCount === 0) {
    const normalizedCount = source.split(escapedOnce).length - 1;
    if (normalizedCount !== 8) {
      throw new Error(
        `bootstrap generator interpolation invariant: expected 8 normalized expressions, found ${normalizedCount}`,
      );
    }
  } else {
    throw new Error(
      `bootstrap generator interpolation invariant: expected 0 or 8 over-escaped expressions, found ${overEscapedCount}`,
    );
  }
}

const materializedMarkers = [
  {
    path: 'packages/domain/src/costing/costing.ts',
    marker: 'export interface CostBootstrapRequest {',
  },
  {
    path: 'packages/domain/src/costing/__tests__/costing.test.ts',
    marker: 'canonicalCostBootstrapForm({',
  },
  {
    path: 'packages/database/src/costing/bootstrap.ts',
    marker: 'export async function recordInventoryCostBootstrap(',
  },
  {
    path: 'packages/database/src/index.ts',
    marker: "export { recordInventoryCostBootstrap } from './costing/bootstrap.js';",
  },
  {
    path: 'apps/api/src/inventory/fingerprint.ts',
    marker: 'export function fingerprintCostBootstrap(',
  },
  {
    path: 'apps/api/src/inventory/service.ts',
    marker: 'async bootstrapCost(principal, request) {',
  },
  {
    path: 'apps/api/src/routes/inventory-admin.ts',
    marker: "'/v1/admin/inventory/cost-bootstrap'",
  },
  {
    path: 'apps/api/src/server.ts',
    marker: 'bootstrapCost: (principal, request) =>',
  },
  {
    path: 'apps/api/src/__tests__/inventory-admin-routes.test.ts',
    marker: 'async bootstrapCost(_principal, request) {',
  },
];

const presentMarkers = materializedMarkers.filter(
  ({ path, marker }) => existsSync(path) && readFileSync(path, 'utf8').includes(marker),
);
if (presentMarkers.length === 0) {
  await import('./strike-5c-bootstrap-materialize.mjs');
} else if (presentMarkers.length !== materializedMarkers.length) {
  const missing = materializedMarkers
    .filter(({ path, marker }) => !existsSync(path) || !readFileSync(path, 'utf8').includes(marker))
    .map(({ path }) => path);
  throw new Error(`partial bootstrap materialization; missing markers in: ${missing.join(', ')}`);
}

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
