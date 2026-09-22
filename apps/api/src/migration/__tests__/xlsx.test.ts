import { deflateRawSync } from 'node:zlib';
import {
  reviewCustomerSheet,
  reviewProductSheet,
  reviewSupplierSheet,
  reviewOpeningInventorySheet,
  suggestCustomerMappings,
  suggestProductMappings,
  suggestSupplierMappings,
  suggestOpeningInventoryMappings,
} from '@korvi/domain';
import { describe, expect, it } from 'vitest';
import { parseXlsxDocument, XlsxParseError } from '../xlsx.js';

interface ZipFixtureEntry {
  readonly name: string;
  readonly data: Buffer;
  readonly deflate?: boolean;
}

function crc32(buffer: Buffer): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value);
  return result;
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0);
  return result;
}

function storedZip(entries: readonly ZipFixtureEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = entry.deflate ? deflateRawSync(entry.data) : entry.data;
    const method = entry.deflate ? 8 : 0;
    const crc = crc32(entry.data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(compressed.length),
      u32(entry.data.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    locals.push(local);
    centrals.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0x0800),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(compressed.length),
        u32(entry.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, central, eocd]);
}

const workbook = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>',
);
const workbookRels = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
    'Target="worksheets/sheet1.xml"/></Relationships>',
);
const sharedStrings = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>' +
    '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<si><t>SKU</t></si><si><t>اسم الصنف</t></si><si><t>A001</t></si><si><t>قهوة</t></si>' +
    '</sst>',
);
const styles = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="000000"/></numFmts>' +
    '<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
);
const sheet = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
    '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3" t="s"><v>3</v></c>' +
    '<c r="C3" s="1"><v>123</v></c><c r="D3"><f>1+1</f><v>2</v></c></row>' +
    '</sheetData></worksheet>',
);

function workbookZip(extra: readonly ZipFixtureEntry[] = []): Buffer {
  return storedZip([
    { name: 'xl/workbook.xml', data: workbook, deflate: true },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
    { name: 'xl/sharedStrings.xml', data: sharedStrings },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet, deflate: true },
    ...extra,
  ]);
}

describe('XLSX migration adapter', () => {
  it('parses a visible worksheet without executing formulas and keeps physical row numbers', () => {
    const document = parseXlsxDocument(workbookZip(), {
      fileName: 'products.xlsx',
      sourceSystem: 'legacy-pos',
    });
    expect(document.source).toEqual({
      format: 'xlsx',
      fileName: 'products.xlsx',
      sourceSystem: 'legacy-pos',
    });
    const parsed = document.sheets[0]!;
    expect(parsed.name).toBe('Products');
    expect(parsed.sourceRowNumbers).toEqual([1, 3]);
    expect(parsed.rows[1]![0]).toMatchObject({ kind: 'text', value: 'A001' });
    expect(parsed.rows[1]![2]).toEqual({ kind: 'number', value: '000123' });
    expect(parsed.rows[1]![3]).toEqual({
      kind: 'formula',
      expression: '1+1',
      cachedValue: '2',
    });
  });

  it('rejects active content and external relationships', () => {
    expect(() =>
      parseXlsxDocument(workbookZip([{ name: 'xl/vbaProject.bin', data: Buffer.from([1, 2, 3]) }])),
    ).toThrow(XlsxParseError);

    const externalRels = Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="x" TargetMode="External" Target="https://example.com/x"/></Relationships>',
    );
    expect(() =>
      parseXlsxDocument(
        storedZip([
          { name: 'xl/workbook.xml', data: workbook },
          { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
          { name: 'xl/worksheets/sheet1.xml', data: sheet },
          { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: externalRels },
        ]),
      ),
    ).toThrow(XlsxParseError);
  });

  it('rejects decompression expansion beyond configured limits', () => {
    expect(() => parseXlsxDocument(workbookZip(), { maxUncompressedBytes: 1024 })).toThrow(
      XlsxParseError,
    );
  });

  it('rejects XML entity declarations before libxml parsing', () => {
    const dangerous = Buffer.from(
      '<?xml version="1.0"?><!DOCTYPE workbook [<!ENTITY x "boom">]>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    expect(() =>
      parseXlsxDocument(
        storedZip([
          { name: 'xl/workbook.xml', data: dangerous },
          { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
          { name: 'xl/worksheets/sheet1.xml', data: sheet },
        ]),
      ),
    ).toThrow(XlsxParseError);
  });

  it('carries Arabic categoryNameAr from XLSX into the product canonical review', () => {
    const categorySharedStrings = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<si><t>SKU</t></si><si><t>اسم الصنف</t></si><si><t>نوع الصنف</t></si>' +
        '<si><t>الوحدة</t></si><si><t>سعر البيع</t></si><si><t>اسم الفئة</t></si>' +
        '<si><t>A-1</t></si><si><t>قهوة</t></si><si><t>unit</t></si>' +
        '<si><t>each</t></si><si><t>10.00</t></si><si><t>مشروبات ساخنة</t></si>' +
        '</sst>',
    );
    const categorySheet = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>' +
        '<c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c>' +
        '<c r="E1" t="s"><v>4</v></c><c r="F1" t="s"><v>5</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2" t="s"><v>7</v></c>' +
        '<c r="C2" t="s"><v>8</v></c><c r="D2" t="s"><v>9</v></c>' +
        '<c r="E2" t="s"><v>10</v></c><c r="F2" t="s"><v>11</v></c></row>' +
        '</sheetData></worksheet>',
    );
    const document = parseXlsxDocument(
      storedZip([
        { name: 'xl/workbook.xml', data: workbook },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
        { name: 'xl/sharedStrings.xml', data: categorySharedStrings },
        { name: 'xl/worksheets/sheet1.xml', data: categorySheet },
      ]),
    );
    const parsed = document.sheets[0]!;
    const mapping = suggestProductMappings(parsed.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(reviewProductSheet(parsed, mapping)[0]).toMatchObject({
      classification: 'VALID',
      record: {
        sku: 'A-1',
        categoryNameAr: 'مشروبات ساخنة',
      },
    });
  });

  it('carries Arabic customer fields from XLSX into the customer canonical review', () => {
    const customerSharedStrings = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<si><t>اسم العميل</t></si><si><t>رقم الجوال</t></si><si><t>البريد الإلكتروني</t></si>' +
        '<si><t>الرقم الضريبي</t></si><si><t>مؤسسة ميم</t></si><si><t>0501234567</t></si>' +
        '<si><t>sales@example.test</t></si><si><t>310000000000003</t></si>' +
        '</sst>',
    );
    const customerSheet = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>' +
        '<c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c>' +
        '<c r="C2" t="s"><v>6</v></c><c r="D2" t="s"><v>7</v></c></row>' +
        '</sheetData></worksheet>',
    );
    const document = parseXlsxDocument(
      storedZip([
        { name: 'xl/workbook.xml', data: workbook },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
        { name: 'xl/sharedStrings.xml', data: customerSharedStrings },
        { name: 'xl/worksheets/sheet1.xml', data: customerSheet },
      ]),
    );
    const parsed = document.sheets[0]!;
    const mapping = suggestCustomerMappings(parsed.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(reviewCustomerSheet(parsed, mapping)[0]).toMatchObject({
      classification: 'VALID',
      record: {
        nameAr: 'مؤسسة ميم',
        phone: '0501234567',
        email: 'sales@example.test',
        vatNumber: '310000000000003',
      },
    });
  });

  it('carries Arabic supplier names from XLSX into the supplier canonical review', () => {
    const supplierSharedStrings = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<si><t>اسم المورد</t></si><si><t>شركة ألف</t></si>' +
        '</sst>',
    );
    const supplierSheet = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>1</v></c></row>' +
        '</sheetData></worksheet>',
    );
    const document = parseXlsxDocument(
      storedZip([
        { name: 'xl/workbook.xml', data: workbook },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
        { name: 'xl/sharedStrings.xml', data: supplierSharedStrings },
        { name: 'xl/worksheets/sheet1.xml', data: supplierSheet },
      ]),
    );
    const parsed = document.sheets[0]!;
    const mapping = suggestSupplierMappings(parsed.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(reviewSupplierSheet(parsed, mapping)[0]).toMatchObject({
      classification: 'VALID',
      record: { name: 'شركة ألف' },
    });
  });

  it('carries opening inventory business keys and quantity from XLSX into canonical review', () => {
    const openingStrings = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<si><t>كود الفرع</t></si><si><t>رقم الصنف</t></si>' +
        '<si><t>الكمية الافتتاحية</t></si><si><t>MAIN</t></si>' +
        '<si><t>SKU-OPEN</t></si><si><t>12.500</t></si></sst>',
    );
    const openingSheet = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>' +
        '<c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c>' +
        '<c r="C2" t="s"><v>5</v></c></row></sheetData></worksheet>',
    );
    const document = parseXlsxDocument(
      storedZip([
        { name: 'xl/workbook.xml', data: workbook },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
        { name: 'xl/sharedStrings.xml', data: openingStrings },
        { name: 'xl/worksheets/sheet1.xml', data: openingSheet },
      ]),
    );
    const parsed = document.sheets[0]!;
    const mapping = suggestOpeningInventoryMappings(parsed.rows[0]!).map((entry) => ({
      sourceColumn: entry.sourceColumn,
      targetField: entry.targetField,
    }));
    expect(reviewOpeningInventorySheet(parsed, mapping)[0]).toMatchObject({
      classification: 'VALID',
      record: {
        branchCode: 'MAIN',
        sku: 'SKU-OPEN',
        quantityScaled: '12500',
      },
    });
  });
});
