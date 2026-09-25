import { expect, it } from 'vitest';
import { createPrismaClient } from '@korvi/database';
import { verifyStagingDatabase } from '../staging/preflight.js';

const url = process.env['KORVI_TEST_DATABASE_URL'] ?? '';

it.skipIf(url === '')('accepts the fully migrated PostgreSQL 17 non-bypass CI role', async () => {
  const prisma = createPrismaClient(url);
  try {
    await expect(verifyStagingDatabase(prisma)).resolves.toBeUndefined();
  } finally {
    await prisma.$disconnect();
  }
});
