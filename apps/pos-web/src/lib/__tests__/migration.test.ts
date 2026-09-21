import { describe, expect, it } from 'vitest';
import {
  migrationCellText,
  migrationMappingProblems,
  PRODUCT_MIGRATION_TEMPLATE_CSV,
  productMigrationProblemsCsv,
} from '../migration';
import type { ProductMigrationRowResult } from '../api-types';

describe('merchant migration presentation helpers', () => {
  it('requires the deterministic product fields and rejects duplicate targets', () => {
    const problems = migrationMappingProblems([
      { sourceColumn: 0, targetField: 'sku' },
      { sourceColumn: 1, targetField: 'sku' },
      { sourceColumn: 2, targetField: 'nameAr' },
    ]);
    expect(problems.map((problem) => problem.code)).toEqual(
      expect.arrayContaining(['duplicate-target', 'required-unmapped']),
    );
  });

  it('renders formula cells as blocked content instead of evaluating them', () => {
    expect(
      migrationCellText({
        kind: 'formula',
        expression: '=SUM(A1:A3)',
        cachedValue: '99',
      }),
    ).toBe('صيغة محظورة');
  });

  it('exports row-level problems with spreadsheet-formula injection neutralized', () => {
    const rows: readonly ProductMigrationRowResult[] = [
      {
        sourceRow: 7,
        sourceIdentifier: '=HYPERLINK("https://evil.test")',
        classification: 'ERROR',
        plannedAction: 'reject',
        status: 'rejected',
        targetEntityId: null,
        errorCode: null,
        issues: [
          {
            classification: 'ERROR',
            code: 'sku-conflict',
            message: '+not-a-formula',
            row: 7,
            sourceColumn: 0,
            targetField: 'sku',
          },
        ],
      },
    ];
    const csv = productMigrationProblemsCsv(rows);
    expect(csv).toContain(`"'=HYPERLINK(""https://evil.test"")"`);
    expect(csv).toContain(`"'+not-a-formula"`);
    expect(csv).not.toContain(`"=HYPERLINK`);
  });

  it('ships an Arabic-first official product template with a concrete example', () => {
    expect(PRODUCT_MIGRATION_TEMPLATE_CSV).toContain('رقم الصنف');
    expect(PRODUCT_MIGRATION_TEMPLATE_CSV).toContain('سعر البيع');
    expect(PRODUCT_MIGRATION_TEMPLATE_CSV).toContain('SKU-001');
  });
});
