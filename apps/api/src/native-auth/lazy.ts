import {
  createAuditRepository,
  createAuthRepository,
  createPrismaClient,
} from '@korvi/database';
import { createNativeAuthService } from './service.js';
import type { ApiConfig } from '../config.js';
import type { NativeAuthService } from './service.js';

const services = new WeakMap<ApiConfig, NativeAuthService>();

/**
 * Native auth remains absent when DATABASE_URL is absent, preserving health and
 * isolated route tests. In a deployed API process both the native auth routes
 * and the merchant guards share the same service instance for this config.
 */
export function nativeAuthServiceFor(config: ApiConfig): NativeAuthService | undefined {
  const existing = services.get(config);
  if (existing !== undefined) return existing;
  const url = config.DATABASE_URL;
  if (url === undefined) return undefined;

  const prisma = createPrismaClient(url);
  const service = createNativeAuthService({
    prisma,
    repository: createAuthRepository(prisma),
    audit: createAuditRepository(prisma),
    // Installed-cashier tokens are deliberately shorter-lived than browser
    // sessions. Device proof can mint a fresh session without weakening the
    // browser cookie boundary.
    sessionTtlSeconds: Math.min(config.SESSION_TTL_SECONDS, 60 * 60),
  });
  services.set(config, service);
  return service;
}
