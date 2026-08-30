import { readFileSync, writeFileSync } from 'node:fs';

function transform(path, work) {
  const before = readFileSync(path, 'utf8');
  const after = work(before);
  if (after !== before) writeFileSync(path, after);
}

function replaceOnce(text, label, before, after) {
  const first = text.indexOf(before);
  if (first === -1) throw new Error(`5C receipt boundary anchor missing: ${label}`);
  if (text.indexOf(before, first + 1) !== -1) {
    throw new Error(`5C receipt boundary anchor is not unique: ${label}`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

transform('packages/domain/src/costing/costing.ts', (source) => {
  if (source.includes(`const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9]\\d{0,18})$/;`)) {
    return source;
  }
  return replaceOnce(
    source,
    'bounded canonical money text',
    `const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9]\\d*)$/;`,
    `const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9]\\d{0,18})$/;`,
  );
});

transform('apps/api/src/routes/purchasing-admin.ts', (source) => {
  if (source.includes("const MAX_POSTGRES_BIGINT_MINOR_TEXT = '9223372036854775807';")) {
    return source;
  }
  return replaceOnce(
    source,
    'non-throwing PostgreSQL BIGINT validator',
    `const MAX_POSTGRES_BIGINT_MINOR = (1n << 63n) - 1n;\nconst NON_NEGATIVE_MINOR = z\n  .string()\n  .regex(/^(0|[1-9][0-9]*)$/, 'must be a canonical non-negative integer string')\n  .refine((value) => BigInt(value) <= MAX_POSTGRES_BIGINT_MINOR, 'must fit PostgreSQL BIGINT');`,
    `const MAX_POSTGRES_BIGINT_MINOR_TEXT = '9223372036854775807';\nconst NON_NEGATIVE_MINOR = z\n  .string()\n  .regex(/^(0|[1-9][0-9]{0,18})$/, 'must be a canonical non-negative integer string')\n  .refine(\n    (value) => value.length < 19 || value <= MAX_POSTGRES_BIGINT_MINOR_TEXT,\n    'must fit PostgreSQL BIGINT',\n  );`,
  );
});
