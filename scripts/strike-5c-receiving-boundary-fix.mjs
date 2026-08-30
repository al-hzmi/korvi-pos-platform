import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, label, before, after) {
  const source = readFileSync(path, 'utf8');
  const first = source.indexOf(before);
  if (first === -1) throw new Error(`5C receipt boundary anchor missing: ${label}`);
  if (source.indexOf(before, first + 1) !== -1) {
    throw new Error(`5C receipt boundary anchor is not unique: ${label}`);
  }
  writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length));
}

replaceOnce(
  'packages/domain/src/costing/costing.ts',
  'bounded canonical money text',
  `const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9]\\d*)$/;`,
  `const CANONICAL_UNSIGNED_INTEGER = /^(0|[1-9]\\d{0,18})$/;`,
);

replaceOnce(
  'apps/api/src/routes/purchasing-admin.ts',
  'non-throwing PostgreSQL BIGINT validator',
  `const MAX_POSTGRES_BIGINT_MINOR = (1n << 63n) - 1n;\nconst NON_NEGATIVE_MINOR = z\n  .string()\n  .regex(/^(0|[1-9][0-9]*)$/, 'must be a canonical non-negative integer string')\n  .refine((value) => BigInt(value) <= MAX_POSTGRES_BIGINT_MINOR, 'must fit PostgreSQL BIGINT');`,
  `const MAX_POSTGRES_BIGINT_MINOR_TEXT = '9223372036854775807';\nconst NON_NEGATIVE_MINOR = z\n  .string()\n  .regex(/^(0|[1-9][0-9]{0,18})$/, 'must be a canonical non-negative integer string')\n  .refine(\n    (value) => value.length < 19 || value <= MAX_POSTGRES_BIGINT_MINOR_TEXT,\n    'must fit PostgreSQL BIGINT',\n  );`,
);
