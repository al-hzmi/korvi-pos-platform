import type {
  CategoryMigrationMapping,
  CategoryMigrationRowResult,
  CategoryMigrationTargetField,
  CustomerMigrationMapping,
  CustomerMigrationRowResult,
  CustomerMigrationTargetField,
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

export const CATEGORY_MIGRATION_REQUIRED_FIELDS: readonly CategoryMigrationTargetField[] = [
  'nameAr',
];

export const CATEGORY_MIGRATION_FIELD_LABELS: Readonly<
  Record<CategoryMigrationTargetField, string>
> = {
  nameAr: 'اسم الفئة بالعربية',
  nameEn: 'اسم الفئة بالإنجليزية',
  sortOrder: 'ترتيب العرض',
};

export const CUSTOMER_MIGRATION_REQUIRED_FIELDS: readonly CustomerMigrationTargetField[] = ['nameAr'];

export const CUSTOMER_MIGRATION_FIELD_LABELS: Readonly<Record<CustomerMigrationTargetField, string>> = {
  nameAr: 'اسم العميل بالعربية',
  nameEn: 'اسم العميل بالإنجليزية',
  phone: 'رقم الجوال',
  email: 'البريد الإلكتروني',
  vatNumber: 'الرقم الضريبي',
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

export function categoryMigrationMappingProblems(
  mappings: readonly CategoryMigrationMapping[],
): readonly MigrationMappingProblem[] {
  const problems: MigrationMappingProblem[] = [];
  const sources = new Set<number>();
  const targets = new Set<CategoryMigrationTargetField>();

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
          'حقل «' + CATEGORY_MIGRATION_FIELD_LABELS[mapping.targetField] + '» مربوط بأكثر من عمود.',
      });
    }
    targets.add(mapping.targetField);
  }

  for (const field of CATEGORY_MIGRATION_REQUIRED_FIELDS) {
    if (!targets.has(field)) {
      problems.push({
        code: 'required-unmapped',
        message: 'الحقل الإلزامي «' + CATEGORY_MIGRATION_FIELD_LABELS[field] + '» غير مربوط.',
      });
    }
  }
  return problems;
}

export function customerMigrationMappingProblems(
  mappings: readonly CustomerMigrationMapping[],
): readonly MigrationMappingProblem[] {
  const problems: MigrationMappingProblem[] = [];
  const sources = new Set<number>();
  const targets = new Set<CustomerMigrationTargetField>();

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
          'حقل «' + CUSTOMER_MIGRATION_FIELD_LABELS[mapping.targetField] + '» مربوط بأكثر من عمود.',
      });
    }
    targets.add(mapping.targetField);
  }

  for (const field of CUSTOMER_MIGRATION_REQUIRED_FIELDS) {
    if (!targets.has(field)) {
      problems.push({
        code: 'required-unmapped',
        message: 'الحقل الإلزامي «' + CUSTOMER_MIGRATION_FIELD_LABELS[field] + '» غير مربوط.',
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

export function categoryMigrationProblemsCsv(rows: readonly CategoryMigrationRowResult[]): string {
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

export const CATEGORY_MIGRATION_TEMPLATE_CSV =
  '\uFEFFاسم الفئة,الاسم الانجليزي,الترتيب\r\n' +
  'مشروبات ساخنة,Hot Drinks,10\r\n' +
  'مخبوزات,Bakery,20\r\n';

export const PRODUCT_MIGRATION_TEMPLATE_CSV =
  '\uFEFFرقم الصنف,رقم الباركود,اسم الصنف,الاسم الانجليزي,اسم الفئة,نوع الصنف,الوحدة,سعر البيع,نسبة الضريبة\r\n' +
  'SKU-001,6281000000001,قهوة,Coffee,مشروبات ساخنة,unit,each,12.50,15%\r\n';
