import { describe, expect, it, vi } from 'vitest';
import { prepareApplicationDatabase } from '../runtime/database-startup.js';
import type { DatabaseStartupHooks } from '../runtime/database-startup.js';
import type { PrismaClient } from '@korvi/database';

const prisma = {} as PrismaClient;

function hooks(calls: string[]): DatabaseStartupHooks {
  return {
    verifyDeploymentDatabase: vi.fn(async () => {
      calls.push('verify');
    }),
    provisionPermissionCatalogue: vi.fn(async () => {
      calls.push('catalogue');
      return 22;
    }),
  };
}

describe('database startup admission', () => {
  it('verifies production before installing the permission catalogue', async () => {
    const calls: string[] = [];

    await expect(
      prepareApplicationDatabase(prisma, { isProduction: true }, hooks(calls)),
    ).resolves.toBe(22);
    expect(calls).toEqual(['verify', 'catalogue']);
  });

  it('installs the permission catalogue on non-production database-backed boots', async () => {
    const calls: string[] = [];

    await expect(
      prepareApplicationDatabase(prisma, { isProduction: false }, hooks(calls)),
    ).resolves.toBe(22);
    expect(calls).toEqual(['catalogue']);
  });

  it('fails closed without mutating catalogue state when production preflight fails', async () => {
    const catalogue = vi.fn(async () => 22);
    const failure = new Error('deployment database refused');

    await expect(
      prepareApplicationDatabase(
        prisma,
        { isProduction: true },
        {
          verifyDeploymentDatabase: vi.fn(async () => {
            throw failure;
          }),
          provisionPermissionCatalogue: catalogue,
        },
      ),
    ).rejects.toBe(failure);
    expect(catalogue).not.toHaveBeenCalled();
  });
});
