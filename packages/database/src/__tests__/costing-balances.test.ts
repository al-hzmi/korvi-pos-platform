import { describe, expect, it } from 'vitest';
import { listCostBalancePage } from '../costing/balances.js';
import type { PrismaClient } from '../client.js';

const TENANT = '018f5d00-0000-7000-8000-00000000000a';
const BRANCH = '018f5d00-0000-7000-8000-0000000000a1';

function row(overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
  return {
    branchId: BRANCH,
    productId: '018f5d00-0000-7000-8000-0000000000a2',
    sku: 'MILK-1L',
    nameAr: 'حليب',
    nameEn: 'Milk',
    productType: 'unit',
    unitLabel: 'حبة',
    isActive: true,
    trackInventory: true,
    quantityScaled: 9_007_199_254_740_993_000n,
    stockMaterialized: true,
    inventoryRevision: 12n,
    costMaterialized: true,
    knownQuantityScaled: 7_000_000_000_000_000_000n,
    knownValueMinor: 900_719_925_474_099_300n,
    costStockRevision: 12n,
    costRevision: 8n,
    ...overrides,
  };
}

function fake(rows: readonly Readonly<Record<string, unknown>>[]): {
  readonly prisma: PrismaClient;
  readonly contextValues: unknown[];
  readonly queryValues: unknown[];
} {
  const contextValues: unknown[] = [];
  const queryValues: unknown[] = [];
  const tx = {
    $executeRaw: (_strings: TemplateStringsArray, ...values: unknown[]) => {
      contextValues.push(...values);
      return Promise.resolve(1);
    },
    $queryRaw: (_strings: TemplateStringsArray, ...values: unknown[]) => {
      queryValues.push(...values);
      return Promise.resolve(rows);
    },
  };
  const prisma = {
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  } as unknown as PrismaClient;
  return { prisma, contextValues, queryValues };
}

describe('cost balance read model', () => {
  it('derives exact unknown positive quantity and preserves strings beyond Number safety', async () => {
    const second = row({ productId: '018f5d00-0000-7000-8000-0000000000a3' });
    const database = fake([row(), second]);
    const page = await listCostBalancePage(database.prisma, TENANT, BRANCH, 1, null);

    expect(page).toEqual({
      rows: [
        {
          branchId: BRANCH,
          productId: '018f5d00-0000-7000-8000-0000000000a2',
          sku: 'MILK-1L',
          nameAr: 'حليب',
          nameEn: 'Milk',
          productType: 'unit',
          unitLabel: 'حبة',
          isActive: true,
          trackInventory: true,
          quantityScaled: '9007199254740993000',
          knownQuantityScaled: '7000000000000000000',
          unknownPositiveQuantityScaled: '2007199254740993000',
          knownValueMinor: '900719925474099300',
          stockRevision: '12',
          costRevision: '8',
        },
      ],
      nextCursor: '018f5d00-0000-7000-8000-0000000000a2',
    });
    expect(database.contextValues).toEqual([TENANT]);
    expect(database.queryValues).toContain(TENANT);
    expect(database.queryValues).toContain(BRANCH);
  });

  it('represents an unmaterialized active zero without writing or inventing value', async () => {
    const database = fake([
      row({
        quantityScaled: 0n,
        stockMaterialized: false,
        inventoryRevision: 0n,
        costMaterialized: false,
        knownQuantityScaled: 0n,
        knownValueMinor: 0n,
        costStockRevision: 0n,
        costRevision: 0n,
      }),
    ]);
    const page = await listCostBalancePage(database.prisma, TENANT, BRANCH, 50, null);
    expect(page.rows[0]).toMatchObject({
      quantityScaled: '0',
      knownQuantityScaled: '0',
      unknownPositiveQuantityScaled: '0',
      knownValueMinor: '0',
    });
  });

  it('fails loudly for a missing or divergent cost cursor and an impossible pool', async () => {
    for (const broken of [
      row({ costStockRevision: 11n }),
      row({ costMaterialized: false, costStockRevision: 0n }),
      row({ stockMaterialized: false, quantityScaled: 0n, inventoryRevision: 0n }),
      row({ knownQuantityScaled: 9_100_000_000_000_000_000n }),
    ]) {
      await expect(
        listCostBalancePage(fake([broken]).prisma, TENANT, BRANCH, 50, null),
      ).rejects.toThrow(/Costing invariant failed/);
    }
  });
});
