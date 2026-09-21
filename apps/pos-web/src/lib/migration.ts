import type {
  MigrationImportCell,
  ProductMigrationMapping,
  ProductMigrationRowResult,
  ProductMigrationTargetField,
} from './api-types';

export const PRODUCT_MIGRATION_REQUIRED_FIELDS: readonly ProductMigrationTargetField[] = [
  'sku',
  'nameAr',
  'productType',
  'unitLabel',
  'sellingPrice',
];

export const PRODUCT_MIGRATION_FIELD_LABELS: Readonly<Record<ProductMigrationTargetField, string>> =
  {
    sku: 'رقم الصنف / SKU',
    barcode: 'الباركود',
    nameAr: 'الاسم العربي',
    nameEn: 'الاسم الإنجليزي',
    categoryNameAr: 'اسم الفئة',
    productType: 'نوع الصنف',
    unitLabel: 'وحدة البيع',
    sellingPrice: 'سعر البيع',
    vatRate: 'نسبة الضريبة',
  };

export interface MigrationMappingProblem {
  readonly code: 'duplicate-source' | 'duplicate-target' | 'required-unmapped';
  readonly message: string;
}

export function migrationMappingProblems(
  mappings: readonly ProductMigrationMapping[],
): readonly MigrationMappingProblem[] {
  const problems: MigrationMappingProblem[] = [];
  const sources = new Set<number>();
  const targets = new Set<ProductMigrationTargetField>();

  for (const mapping of mappings) {
    if (sources.has(mapping.sourceColumn)) {
      problems.push({
        code: 'duplicate-source',
        message: 'عمود المصدر رقم ' + String(mapping.sourceColumn + 1) + ' مربوط أكثر من مرة.',
      });
    }
    sources.add(mapping.sourceColumn);
    if (mapping.targetField === null) continue;
    if (targets.has(mapping.targetField)) {
      problems.push({
        code: 'duplicate-target',
        message:
          'حقل «' + PRODUCT_MIGRATION_FIELD_LABELS[mapping.targetField] + '» مربوط بأكثر من عمود.',
      });
    }
    targets.add(mapping.targetField);
  }

  for (const field of PRODUCT_MIGRATION_REQUIRED_FIELDS) {
    if (!targets.has(field)) {
      problems.push({
        code: 'required-unmapped',
        message: 'الحقل الإلزامي «' + PRODUCT_MIGRATION_FIELD_LABELS[field] + '» غير مربوط.',
      });
    }
  }
  return problems;
}

export function migrationCellText(cell: MigrationImportCell): string {
  switch (cell.kind) {
    case 'blank':
      return '';
    case 'text':
    case 'number':
      return cell.value;
    case 'boolean':
      return cell.value ? 'true' : 'false';
    case 'formula':
      return 'صيغة محظورة';
  }
}

function protectCsvFormula(value: string): string {
  return /^[=+\-@]/u.test(value.trimStart()) ? "'" + value : value;
}

function csvCell(value: string): string {
  const safe = protectCsvFormula(value);
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function productMigrationProblemsCsv(rows: readonly ProductMigrationRowResult[]): string {
  const header = ['ROW', 'SOURCE IDENTIFIER', 'FIELD', 'ERROR', 'REASON'];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    if (row.issues.length === 0 && row.errorCode === null) continue;
    if (row.issues.length === 0) {
      lines.push(
        [
          String(row.sourceRow),
          row.sourceIdentifier ?? '',
          '',
          row.errorCode ?? '',
          row.errorCode ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
      continue;
    }
    for (const issue of row.issues) {
      lines.push(
        [
          String(row.sourceRow),
          row.sourceIdentifier ?? '',
          issue.targetField ?? '',
          issue.code,
          issue.message,
        ]
          .map(csvCell)
          .join(','),
      );
    }
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export const PRODUCT_MIGRATION_TEMPLATE_CSV =
  '\uFEFFرقم الصنف,رقم الباركود,اسم الصنف,الاسم الانجليزي,اسم الفئة,نوع الصنف,الوحدة,سعر البيع,نسبة الضريبة\r\n' +
  'SKU-001,6281000000001,قهوة,Coffee,مشروبات ساخنة,unit,each,12.50,15%\r\n';
