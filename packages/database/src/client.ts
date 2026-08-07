import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/client/client.js';

/**
 * Build a client.
 *
 * The connection string is a parameter rather than an ambient read so that a
 * caller cannot accidentally connect to the wrong database by having the wrong
 * environment loaded, and so tests can be explicit about talking to nothing.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  if (connectionString.trim() === '') {
    throw new Error('createPrismaClient: a connection string is required.');
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export type { PrismaClient };
