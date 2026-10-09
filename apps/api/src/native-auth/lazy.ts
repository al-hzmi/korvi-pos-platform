import { createAuditRepository, createAuthRepository, createPrismaClient } from '@korvi/database';
import { createNativeAuthService } from './service.js';
import { createOfflineLeaseService } from './offline-lease.js';
import type { ApiConfig } from '../config.js';
import type { NativeAuthService } from './service.js';
import type { OfflineLeaseService } from './offline-lease.js';

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

const offlineServices = new WeakMap<ApiConfig, OfflineLeaseService>();

export function offlineLeaseServiceFor(config: ApiConfig): OfflineLeaseService | undefined {
  const existing = offlineServices.get(config);
  if (existing !== undefined) return existing;
  const url = config.DATABASE_URL;
  const seed = config.OFFLINE_LEASE_SIGNING_SEED_B64;
  const keyId = config.OFFLINE_LEASE_KEY_ID;
  if (url === undefined || seed === undefined || keyId === undefined) return undefined;
  const native = nativeAuthServiceFor(config);
  if (native === undefined) return undefined;
  const prisma = createPrismaClient(url);
  const service = createOfflineLeaseService({
    prisma,
    native,
    audit: createAuditRepository(prisma),
    signingSeedBase64Url: seed,
    keyId,
    ttlSeconds: config.OFFLINE_LEASE_TTL_SECONDS ?? 72 * 60 * 60,
  });
  offlineServices.set(config, service);
  return service;
}
