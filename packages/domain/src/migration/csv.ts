import { textCell } from './normalization.js';
import type { ImportDocument, ImportSheet } from './model.js';

export interface CsvParseOptions {
  readonly delimiter?: ',' | ';' | '\t';
  readonly maxRows?: number;
  readonly maxColumns?: number;
  readonly maxCellCharacters?: number;
  readonly fileName?: string | null;
  readonly sourceSystem?: string | null;
}

export class ImportParseError extends Error {
  public override readonly name = 'ImportParseError';
}

const DEFAULT_MAX_ROWS = 50_000;
const DEFAULT_MAX_COLUMNS = 200;
const DEFAULT_MAX_CELL_CHARACTERS = 20_000;

function assertLimit(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ImportParseError(`Invalid ${label} limit.`);
  }
  return value;
}

export function parseCsvDocument(text: string, options: CsvParseOptions = {}): ImportDocument {
  if (text.includes('\0')) throw new ImportParseError('CSV contains NUL characters.');

  const delimiter = options.delimiter ?? ',';
  const maxRows = assertLimit(options.maxRows ?? DEFAULT_MAX_ROWS, 1, 1_000_000, 'row');
  const maxColumns = assertLimit(options.maxColumns ?? DEFAULT_MAX_COLUMNS, 1, 10_000, 'column');
  const maxCellCharacters = assertLimit(
    options.maxCellCharacters ?? DEFAULT_MAX_CELL_CHARACTERS,
    1,
    1_000_000,
    'cell',
  );

  const rows: Array<Array<ReturnType<typeof textCell>>> = [];
  const sourceRowNumbers: number[] = [];
  let row: Array<ReturnType<typeof textCell>> = [];
  let cell = '';
  let quoted = false;
  let index = 0;
  let sourceRow = 1;

  const pushCell = (): void => {
    if (cell.length > maxCellCharacters) {
      throw new ImportParseError('CSV cell exceeds configured size limit.');
    }
    row.push(textCell(cell));
    if (row.length > maxColumns) {
      throw new ImportParseError('CSV row exceeds configured column limit.');
    }
    cell = '';
  };

  const pushRow = (): void => {
    pushCell();
    const hasValue = row.some((entry) => entry.kind !== 'blank');
    if (hasValue) {
      rows.push(row);
      sourceRowNumbers.push(sourceRow);
    }
    if (rows.length > maxRows) {
      throw new ImportParseError('CSV exceeds configured row limit.');
    }
    row = [];
    sourceRow += 1;
  };

  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (index < source.length) {
    const character = source[index]!;
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      cell += character;
      index += 1;
      continue;
    }

    if (character === '"') {
      if (cell !== '') throw new ImportParseError('Unexpected quote inside unquoted CSV cell.');
      quoted = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      pushCell();
      index += 1;
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      pushRow();
      index += 1;
      continue;
    }
    cell += character;
    if (cell.length > maxCellCharacters) {
      throw new ImportParseError('CSV cell exceeds configured size limit.');
    }
    index += 1;
  }

  if (quoted) throw new ImportParseError('CSV ended inside a quoted field.');
  if (cell !== '' || row.length > 0) pushRow();

  const sheet: ImportSheet = { name: 'CSV', rows, sourceRowNumbers };
  return {
    source: {
      format: 'csv',
      fileName: options.fileName ?? null,
      sourceSystem: options.sourceSystem ?? null,
    },
    sheets: [sheet],
  };
}
