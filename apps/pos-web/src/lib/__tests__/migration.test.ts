import { describe, expect, it } from 'vitest';
import {
  CATEGORY_MIGRATION_TEMPLATE_CSV,
  CUSTOMER_MIGRATION_TEMPLATE_CSV,
  SUPPLIER_MIGRATION_TEMPLATE_CSV,
  categoryMigrationMappingProblems,
  categoryMigrationProblemsCsv,
  customerMigrationMappingProblems,
  customerMigrationProblemsCsv,
  supplierMigrationMappingProblems,
  supplierMigrationProblemsCsv,
  migrationCellText,
  migrationMappingProblems,
  PRODUCT_MIGRATION_TEMPLATE_CSV,
  productMigrationProblemsCsv,
} from '../migration';
import type {
  CategoryMigrationRowResult,
  CustomerMigrationRowResult,
  SupplierMigrationRowResult,
  ProductMigrationRowResult,
} from '../api-types';

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

  it('ships category mapping rules, Arabic template and formula-safe category error export', () => {
    expect(
      categoryMigrationMappingProblems([
        { sourceColumn: 0, targetField: null },
        { sourceColumn: 1, targetField: 'sortOrder' },
      ]),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'required-unmapped' })]));
    expect(CATEGORY_MIGRATION_TEMPLATE_CSV).toContain('اسم الفئة');
    expect(CATEGORY_MIGRATION_TEMPLATE_CSV).toContain('مشروبات ساخنة');

    const rows: readonly CategoryMigrationRowResult[] = [
      {
        sourceRow: 4,
        sourceIdentifier: '=CMD',
        classification: 'ERROR',
        plannedAction: 'reject',
        status: 'rejected',
        targetEntityId: null,
        errorCode: null,
        issues: [
          {
            classification: 'ERROR',
            code: 'category-conflict',
            message: '+existing',
            row: 4,
            sourceColumn: 0,
            targetField: 'nameAr',
          },
        ],
      },
    ];
    const csv = categoryMigrationProblemsCsv(rows);
    expect(csv).toContain('"\'=CMD"');
    expect(csv).toContain('"\'+existing"');
  });

  it('includes category name in the official product template without exposing categoryId', () => {
    expect(PRODUCT_MIGRATION_TEMPLATE_CSV).toContain('اسم الفئة');
    expect(PRODUCT_MIGRATION_TEMPLATE_CSV).toContain('مشروبات ساخنة');
    expect(PRODUCT_MIGRATION_TEMPLATE_CSV).not.toContain('categoryId');
  });

  it('ships customer mapping rules, Arabic template and formula-safe customer error export', () => {
    expect(
      customerMigrationMappingProblems([
        { sourceColumn: 0, targetField: null },
        { sourceColumn: 1, targetField: 'phone' },
      ]),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'required-unmapped' })]));

    expect(CUSTOMER_MIGRATION_TEMPLATE_CSV).toContain('اسم العميل');
    expect(CUSTOMER_MIGRATION_TEMPLATE_CSV).toContain('رقم الجوال');
    expect(CUSTOMER_MIGRATION_TEMPLATE_CSV).toContain('الرقم الضريبي');

    const rows: readonly CustomerMigrationRowResult[] = [
      {
        sourceRow: 9,
        sourceIdentifier: '=CMD',
        classification: 'ERROR',
        plannedAction: 'reject',
        status: 'rejected',
        targetEntityId: null,
        errorCode: null,
        issues: [
          {
            classification: 'ERROR',
            code: 'phone-conflict',
            message: '+existing',
            row: 9,
            sourceColumn: 2,
            targetField: 'phone',
          },
        ],
      },
    ];
    const csv = customerMigrationProblemsCsv(rows);
    expect(csv).toContain('"\'=CMD"');
    expect(csv).toContain('"\'+existing"');
  });

  it('ships supplier name-only mapping, template and formula-safe error export', () => {
    expect(supplierMigrationMappingProblems([{ sourceColumn: 0, targetField: null }])).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'required-unmapped' })]),
    );

    expect(SUPPLIER_MIGRATION_TEMPLATE_CSV).toContain('اسم المورد');
    expect(SUPPLIER_MIGRATION_TEMPLATE_CSV).not.toMatch(/جوال|هاتف|ضريبي|دفع|ائتمان/);

    const rows: readonly SupplierMigrationRowResult[] = [
      {
        sourceRow: 11,
        sourceIdentifier: '=CMD',
        classification: 'ERROR',
        plannedAction: 'reject',
        status: 'rejected',
        targetEntityId: null,
        errorCode: null,
        issues: [
          {
            classification: 'ERROR',
            code: 'invalid-supplier-row',
            message: '+invalid',
            row: 11,
            sourceColumn: 0,
            targetField: 'name',
          },
        ],
      },
    ];
    const csv = supplierMigrationProblemsCsv(rows);
    expect(csv).toContain('"\'=CMD"');
    expect(csv).toContain('"\'+invalid"');
  });
});
