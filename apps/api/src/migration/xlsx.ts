import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';
import { ParseOption, XmlDocument } from 'libxml2-wasm';
import { textCell } from '@korvi/domain';
import type { ImportCell, ImportDocument, ImportSheet } from '@korvi/domain';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL_NS =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';

const XML_OPTIONS = {
  option:
    ParseOption.XML_PARSE_NO_XXE |
    ParseOption.XML_PARSE_NONET |
    ParseOption.XML_PARSE_NO_SYS_CATALOG,
} as const;

export interface XlsxParseOptions {
  readonly fileName?: string | null;
  readonly sourceSystem?: string | null;
  readonly maxEntries?: number;
  readonly maxUncompressedBytes?: number;
  readonly maxEntryBytes?: number;
  readonly maxCompressionRatio?: number;
  readonly maxRows?: number;
  readonly maxColumns?: number;
  readonly maxCellCharacters?: number;
}

export class XlsxParseError extends Error {
  public override readonly name = 'XlsxParseError';
}

interface ZipEntry {
  readonly name: string;
  readonly flags: number;
  readonly method: number;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

interface XlsxStyleTable {
  readonly numberFormatByStyle: readonly (string | null)[];
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_UNCOMPRESSED = 40 * 1024 * 1024;
const DEFAULT_MAX_ENTRY = 12 * 1024 * 1024;
const DEFAULT_MAX_RATIO = 250;
const DEFAULT_MAX_ROWS = 50_001;
const DEFAULT_MAX_COLUMNS = 200;
const DEFAULT_MAX_CELL_CHARACTERS = 20_000;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new XlsxParseError(`Invalid XLSX ${label} limit.`);
  }
  return resolved;
}

function u16(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > buffer.length) throw new XlsxParseError('Truncated ZIP.');
  return buffer.readUInt16LE(offset);
}

function u32(buffer: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > buffer.length) throw new XlsxParseError('Truncated ZIP.');
  return buffer.readUInt32LE(offset);
}

function findEocd(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (u32(buffer, offset) === EOCD_SIGNATURE) return offset;
  }
  throw new XlsxParseError('ZIP end-of-central-directory record not found.');
}

function safeZipName(raw: Buffer): string {
  const name = raw.toString('utf8').replace(/\\/gu, '/');
  if (
    name === '' ||
    name.includes('\0') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/u.test(name) ||
    name.split('/').some((part) => part === '..')
  ) {
    throw new XlsxParseError('Unsafe ZIP entry path.');
  }
  return posix.normalize(name).replace(/^\.\//u, '');
}

function parseCentralDirectory(
  source: Buffer,
  options: Required<
    Pick<
      XlsxParseOptions,
      'maxEntries' | 'maxUncompressedBytes' | 'maxEntryBytes' | 'maxCompressionRatio'
    >
  >,
): Map<string, ZipEntry> {
  const eocd = findEocd(source);
  const disk = u16(source, eocd + 4);
  const centralDisk = u16(source, eocd + 6);
  const diskEntries = u16(source, eocd + 8);
  const totalEntries = u16(source, eocd + 10);
  const centralSize = u32(source, eocd + 12);
  const centralOffset = u32(source, eocd + 16);
  const commentLength = u16(source, eocd + 20);

  if (eocd + 22 + commentLength !== source.length) {
    throw new XlsxParseError('ZIP has unexpected trailing data.');
  }
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new XlsxParseError('Multi-disk ZIP files are not supported.');
  }
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new XlsxParseError('Zip64 XLSX files are not supported.');
  }
  if (totalEntries > options.maxEntries) {
    throw new XlsxParseError('XLSX contains too many ZIP entries.');
  }
  if (centralOffset + centralSize > eocd) {
    throw new XlsxParseError('ZIP central directory is out of bounds.');
  }

  const entries = new Map<string, ZipEntry>();
  const foldedNames = new Set<string>();
  let offset = centralOffset;
  let totalUncompressed = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (u32(source, offset) !== CENTRAL_SIGNATURE) {
      throw new XlsxParseError('Malformed ZIP central directory.');
    }
    const flags = u16(source, offset + 8);
    const method = u16(source, offset + 10);
    const crc32 = u32(source, offset + 16);
    const compressedSize = u32(source, offset + 20);
    const uncompressedSize = u32(source, offset + 24);
    const nameLength = u16(source, offset + 28);
    const extraLength = u16(source, offset + 30);
    const fileCommentLength = u16(source, offset + 32);
    const diskStart = u16(source, offset + 34);
    const localOffset = u32(source, offset + 42);
    const end = offset + 46 + nameLength + extraLength + fileCommentLength;
    if (end > source.length) throw new XlsxParseError('Truncated ZIP central entry.');
    if (diskStart !== 0) throw new XlsxParseError('Multi-disk ZIP entry is not supported.');
    if ((flags & ENCRYPTED_FLAG) !== 0) throw new XlsxParseError('Encrypted XLSX is not supported.');
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) {
      throw new XlsxParseError('Unsupported XLSX compression method.');
    }
    const name = safeZipName(source.subarray(offset + 46, offset + 46 + nameLength));
    const folded = name.toLocaleLowerCase('en-US');
    if (entries.has(name) || foldedNames.has(folded)) {
      throw new XlsxParseError('Duplicate XLSX ZIP entry.');
    }
    foldedNames.add(folded);

    if (uncompressedSize > options.maxEntryBytes) {
      throw new XlsxParseError('XLSX ZIP entry exceeds configured size limit.');
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > options.maxUncompressedBytes) {
      throw new XlsxParseError('XLSX expands beyond configured size limit.');
    }
    if (
      compressedSize > 0 &&
      uncompressedSize / compressedSize > options.maxCompressionRatio
    ) {
      throw new XlsxParseError('XLSX compression ratio exceeds configured limit.');
    }
    entries.set(name, {
      name,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
    });
    offset = end;
  }

  if (offset !== centralOffset + centralSize) {
    throw new XlsxParseError('ZIP central directory length mismatch.');
  }
  return entries;
}

let crcTable: Uint32Array | null = null;
function tableForCrc(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crc32(buffer: Buffer): number {
  const table = tableForCrc();
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function entryBuffer(source: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localOffset;
  if (u32(source, offset) !== LOCAL_SIGNATURE) {
    throw new XlsxParseError('ZIP local header is missing.');
  }
  const flags = u16(source, offset + 6);
  const method = u16(source, offset + 8);
  const nameLength = u16(source, offset + 26);
  const extraLength = u16(source, offset + 28);
  if ((flags & ENCRYPTED_FLAG) !== 0 || method !== entry.method) {
    throw new XlsxParseError('ZIP local header conflicts with central directory.');
  }
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > source.length) throw new XlsxParseError('Truncated ZIP entry payload.');
  const compressed = source.subarray(dataStart, dataEnd);
  let output: Buffer;
  if (entry.method === METHOD_STORED) {
    output = Buffer.from(compressed);
  } else {
    try {
      output = inflateRawSync(compressed, {
        maxOutputLength: entry.uncompressedSize + 1,
      });
    } catch {
      throw new XlsxParseError('Invalid or oversized deflate stream.');
    }
  }
  if (output.length !== entry.uncompressedSize) {
    throw new XlsxParseError('ZIP entry uncompressed size mismatch.');
  }
  if (crc32(output) !== entry.crc32) throw new XlsxParseError('ZIP entry CRC mismatch.');
  return output;
}

function requiredEntry(
  source: Buffer,
  entries: ReadonlyMap<string, ZipEntry>,
  name: string,
): Buffer {
  const entry = entries.get(name);
  if (entry === undefined) throw new XlsxParseError(`Required XLSX part is missing: ${name}.`);
  return entryBuffer(source, entry);
}

function optionalEntry(
  source: Buffer,
  entries: ReadonlyMap<string, ZipEntry>,
  name: string,
): Buffer | null {
  const entry = entries.get(name);
  return entry === undefined ? null : entryBuffer(source, entry);
}

function rejectActiveOrExternalParts(entries: ReadonlyMap<string, ZipEntry>): void {
  const forbidden = [
    /^xl\/vbaProject\.bin$/iu,
    /^xl\/macrosheets\//iu,
    /^xl\/externalLinks\//iu,
    /^xl\/embeddings\//iu,
    /^xl\/oleObjects\//iu,
  ];
  for (const name of entries.keys()) {
    if (forbidden.some((pattern) => pattern.test(name))) {
      throw new XlsxParseError('XLSX contains active or externally linked content.');
    }
  }
}

function parseXml(buffer: Buffer): XmlDocument {
  const text = buffer.toString('utf8');
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) {
    throw new XlsxParseError('DTD/entity declarations are not allowed in XLSX XML.');
  }
  try {
    return XmlDocument.fromBuffer(buffer, XML_OPTIONS);
  } catch {
    throw new XlsxParseError('Malformed XLSX XML part.');
  }
}

function rejectExternalRelationships(source: Buffer, entries: ReadonlyMap<string, ZipEntry>): void {
  for (const entry of entries.values()) {
    if (!entry.name.endsWith('.rels')) continue;
    const doc = parseXml(entryBuffer(source, entry));
    try {
      for (const relation of doc.find('/r:Relationships/r:Relationship', {
        r: PACKAGE_REL_NS,
      })) {
        if (relation.get('@TargetMode')?.content?.toLocaleLowerCase('en-US') === 'external') {
          throw new XlsxParseError('External XLSX relationships are not allowed.');
        }
      }
    } finally {
      doc.dispose();
    }
  }
}

function relationshipTarget(base: string, target: string): string {
  if (target === '' || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target)) {
    throw new XlsxParseError('Unsafe XLSX relationship target.');
  }
  const rootRelative = target.startsWith('/');
  const normalized = rootRelative
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join(base, target));
  if (
    normalized === '' ||
    normalized.startsWith('../') ||
    normalized === '..' ||
    normalized.includes('\0')
  ) {
    throw new XlsxParseError('Unsafe XLSX relationship target.');
  }
  return normalized;
}

function firstWorksheetPath(source: Buffer, entries: ReadonlyMap<string, ZipEntry>): {
  readonly name: string;
  readonly path: string;
} {
  const workbook = parseXml(requiredEntry(source, entries, 'xl/workbook.xml'));
  const relationships = parseXml(requiredEntry(source, entries, 'xl/_rels/workbook.xml.rels'));
  try {
    const relationById = new Map<string, string>();
    for (const relation of relationships.find('/r:Relationships/r:Relationship', {
      r: PACKAGE_REL_NS,
    })) {
      const id = relation.get('@Id')?.content ?? '';
      const target = relation.get('@Target')?.content ?? '';
      const targetMode = relation.get('@TargetMode')?.content ?? '';
      if (targetMode.toLocaleLowerCase('en-US') === 'external') {
        throw new XlsxParseError('External XLSX relationships are not allowed.');
      }
      if (id !== '') relationById.set(id, relationshipTarget('xl', target));
    }

    const sheets = workbook.find('/x:workbook/x:sheets/x:sheet', {
      x: SHEET_NS,
      r: OFFICE_REL_NS,
    });
    for (const sheet of sheets) {
      const state = sheet.get('@state')?.content ?? 'visible';
      if (state === 'hidden' || state === 'veryHidden') continue;
      const relationshipId = sheet.get('@r:id', { r: OFFICE_REL_NS })?.content ?? '';
      const path = relationById.get(relationshipId);
      if (path === undefined || !path.startsWith('xl/worksheets/')) {
        throw new XlsxParseError('Workbook sheet relationship is invalid.');
      }
      return { name: sheet.get('@name')?.content ?? 'Sheet', path };
    }
    throw new XlsxParseError('XLSX contains no visible worksheet.');
  } finally {
    workbook.dispose();
    relationships.dispose();
  }
}

function sharedStrings(source: Buffer, entries: ReadonlyMap<string, ZipEntry>): readonly string[] {
  const part = optionalEntry(source, entries, 'xl/sharedStrings.xml');
  if (part === null) return [];
  const doc = parseXml(part);
  try {
    const values = doc.find('/x:sst/x:si', { x: SHEET_NS }).map((item) =>
      item
        .find('.//x:t', { x: SHEET_NS })
        .map((node) => node.content)
        .join(''),
    );
    if (values.length > 250_000) throw new XlsxParseError('XLSX has too many shared strings.');
    return values;
  } finally {
    doc.dispose();
  }
}

function styles(source: Buffer, entries: ReadonlyMap<string, ZipEntry>): XlsxStyleTable {
  const part = optionalEntry(source, entries, 'xl/styles.xml');
  if (part === null) return { numberFormatByStyle: [] };
  const doc = parseXml(part);
  try {
    const custom = new Map<number, string>();
    for (const node of doc.find('/x:styleSheet/x:numFmts/x:numFmt', { x: SHEET_NS })) {
      const id = Number(node.get('@numFmtId')?.content ?? 'NaN');
      const code = node.get('@formatCode')?.content;
      if (Number.isInteger(id) && id >= 0 && code !== undefined) custom.set(id, code);
    }
    const numberFormatByStyle = doc
      .find('/x:styleSheet/x:cellXfs/x:xf', { x: SHEET_NS })
      .map((node) => {
        const id = Number(node.get('@numFmtId')?.content ?? '0');
        return custom.get(id) ?? null;
      });
    return { numberFormatByStyle };
  } finally {
    doc.dispose();
  }
}

function columnIndex(reference: string): number {
  const match = /^([A-Z]{1,4})([1-9][0-9]*)$/u.exec(reference);
  if (match === null) throw new XlsxParseError('Invalid XLSX cell reference.');
  let column = 0;
  for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
  return column - 1;
}

function simpleLeadingZeroFormat(
  raw: string,
  styleIndex: number | null,
  table: XlsxStyleTable,
): string {
  if (styleIndex === null || !/^[0-9]+$/u.test(raw)) return raw;
  const code = table.numberFormatByStyle[styleIndex];
  if (code === null || code === undefined || !/^0+$/u.test(code)) return raw;
  return raw.padStart(code.length, '0');
}

function cellFromNode(
  node: ReturnType<XmlDocument['find']>[number],
  strings: readonly string[],
  styleTable: XlsxStyleTable,
  maxCellCharacters: number,
): ImportCell {
  const type = node.get('@t')?.content ?? '';
  const formula = node.get('x:f', { x: SHEET_NS });
  const value = node.get('x:v', { x: SHEET_NS })?.content ?? '';
  if (formula !== null) {
    if (formula.content.length > maxCellCharacters || value.length > maxCellCharacters) {
      throw new XlsxParseError('XLSX formula cell exceeds configured size limit.');
    }
    return {
      kind: 'formula',
      expression: formula.content,
      cachedValue: value === '' ? null : value,
    };
  }

  let resolved: ImportCell;
  if (type === 's') {
    if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
      throw new XlsxParseError('Invalid shared-string index.');
    }
    const shared = strings[Number(value)];
    if (shared === undefined) throw new XlsxParseError('Shared-string index is out of range.');
    resolved = textCell(shared);
  } else if (type === 'inlineStr') {
    const text = node
      .find('.//x:is//x:t', { x: SHEET_NS })
      .map((item) => item.content)
      .join('');
    resolved = textCell(text);
  } else if (type === 'b') {
    if (value !== '0' && value !== '1') throw new XlsxParseError('Invalid XLSX boolean cell.');
    resolved = { kind: 'boolean', value: value === '1' };
  } else if (type === 'str' || type === 'e' || type === 'd') {
    resolved = textCell(value);
  } else if (value === '') {
    resolved = { kind: 'blank' };
  } else {
    if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[Ee][+-]?[0-9]+)?$/u.test(value)) {
      throw new XlsxParseError('Invalid XLSX numeric cell.');
    }
    const styleRaw = node.get('@s')?.content;
    const styleIndex =
      styleRaw === undefined
        ? null
        : /^(0|[1-9][0-9]*)$/u.test(styleRaw)
          ? Number(styleRaw)
          : null;
    resolved = { kind: 'number', value: simpleLeadingZeroFormat(value, styleIndex, styleTable) };
  }

  const text =
    resolved.kind === 'text'
      ? resolved.value
      : resolved.kind === 'number'
        ? resolved.value
        : null;
  if (text !== null && text.length > maxCellCharacters) {
    throw new XlsxParseError('XLSX cell exceeds configured size limit.');
  }
  return resolved;
}

function worksheet(
  source: Buffer,
  entries: ReadonlyMap<string, ZipEntry>,
  path: string,
  name: string,
  strings: readonly string[],
  styleTable: XlsxStyleTable,
  maxRows: number,
  maxColumns: number,
  maxCellCharacters: number,
): ImportSheet {
  const doc = parseXml(requiredEntry(source, entries, path));
  try {
    const rows: ImportCell[][] = [];
    const sourceRowNumbers: number[] = [];
    let previousRow = 0;
    for (const rowNode of doc.find('/x:worksheet/x:sheetData/x:row', { x: SHEET_NS })) {
      const rowRaw = rowNode.get('@r')?.content;
      const rowNumber =
        rowRaw === undefined
          ? previousRow + 1
          : /^[1-9][0-9]*$/u.test(rowRaw)
            ? Number(rowRaw)
            : Number.NaN;
      if (!Number.isSafeInteger(rowNumber) || rowNumber <= previousRow) {
        throw new XlsxParseError('Invalid or unordered XLSX row number.');
      }
      previousRow = rowNumber;
      const cells: ImportCell[] = [];
      for (const cell of rowNode.find('x:c', { x: SHEET_NS })) {
        const reference = cell.get('@r')?.content;
        if (reference === undefined) throw new XlsxParseError('XLSX cell is missing reference.');
        const column = columnIndex(reference);
        if (column >= maxColumns) throw new XlsxParseError('XLSX exceeds configured column limit.');
        while (cells.length < column) cells.push({ kind: 'blank' });
        if (cells.length !== column) throw new XlsxParseError('Duplicate or unordered XLSX cell.');
        cells.push(cellFromNode(cell, strings, styleTable, maxCellCharacters));
      }
      if (cells.some((cell) => cell.kind !== 'blank')) {
        rows.push(cells);
        sourceRowNumbers.push(rowNumber);
        if (rows.length > maxRows) throw new XlsxParseError('XLSX exceeds configured row limit.');
      }
    }
    return { name, rows, sourceRowNumbers };
  } finally {
    doc.dispose();
  }
}

export function parseXlsxDocument(
  source: Buffer,
  options: XlsxParseOptions = {},
): ImportDocument {
  if (source.length < 22) throw new XlsxParseError('XLSX ZIP is too small.');
  const maxEntries = boundedInteger(options.maxEntries, DEFAULT_MAX_ENTRIES, 4, 10_000, 'entry');
  const maxUncompressedBytes = boundedInteger(
    options.maxUncompressedBytes,
    DEFAULT_MAX_UNCOMPRESSED,
    1024,
    512 * 1024 * 1024,
    'uncompressed-byte',
  );
  const maxEntryBytes = boundedInteger(
    options.maxEntryBytes,
    DEFAULT_MAX_ENTRY,
    1024,
    128 * 1024 * 1024,
    'entry-byte',
  );
  const maxCompressionRatio = boundedInteger(
    options.maxCompressionRatio,
    DEFAULT_MAX_RATIO,
    1,
    10_000,
    'compression-ratio',
  );
  const maxRows = boundedInteger(options.maxRows, DEFAULT_MAX_ROWS, 1, 1_000_000, 'row');
  const maxColumns = boundedInteger(options.maxColumns, DEFAULT_MAX_COLUMNS, 1, 16_384, 'column');
  const maxCellCharacters = boundedInteger(
    options.maxCellCharacters,
    DEFAULT_MAX_CELL_CHARACTERS,
    1,
    1_000_000,
    'cell',
  );

  const entries = parseCentralDirectory(source, {
    maxEntries,
    maxUncompressedBytes,
    maxEntryBytes,
    maxCompressionRatio,
  });
  rejectActiveOrExternalParts(entries);
  rejectExternalRelationships(source, entries);
  const selected = firstWorksheetPath(source, entries);
  const strings = sharedStrings(source, entries);
  const styleTable = styles(source, entries);
  const sheet = worksheet(
    source,
    entries,
    selected.path,
    selected.name,
    strings,
    styleTable,
    maxRows,
    maxColumns,
    maxCellCharacters,
  );
  if (sheet.rows.length === 0) throw new XlsxParseError('XLSX worksheet is empty.');

  return {
    source: {
      format: 'xlsx',
      fileName: options.fileName ?? null,
      sourceSystem: options.sourceSystem ?? null,
    },
    sheets: [sheet],
  };
}
