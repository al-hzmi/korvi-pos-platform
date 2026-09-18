import { z } from 'zod';
import { createLoginAdmissionController } from '../auth/login-admission.js';
import { readNativeAuthorization } from '../native-auth/header.js';
import type { NativeAuthService } from '../native-auth/service.js';
import type { OfflineLeaseService } from '../native-auth/offline-lease.js';
import type { LoginAdmissionController } from '../auth/login-admission.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance } from 'fastify';

const UUID = z.string().uuid();
const challengeBody = z.object({
  tenantId: UUID,
  deviceEnrollmentId: UUID,
});
const loginBody = z.object({
  tenantId: UUID,
  deviceEnrollmentId: UUID,
  challengeId: UUID,
  tenantSlug: z.string().min(1).max(64),
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
  signature: z.string().min(1).max(256),
});

const UNAUTHENTICATED = { error: 'native_unauthenticated' } as const;
const DEVICE_REFUSED = { error: 'native_device_refused' } as const;
const TOO_MANY_REQUESTS = { error: 'too_many_requests' } as const;

const NATIVE_CHALLENGE_ADMISSION_POLICY = {
  globalLimit: 120,
  identityLimit: 20,
  windowMs: 60_000,
  maxConcurrent: 8,
  maxTrackedIdentities: 4_096,
} as const;

const NATIVE_LOGIN_ADMISSION_POLICY = {
  globalLimit: 60,
  identityLimit: 10,
  windowMs: 60_000,
  maxConcurrent: 2,
  maxTrackedIdentities: 4_096,
} as const;

function safePrincipal(principal: AuthenticatedPrincipal): Record<string, unknown> {
  return {
    user: {
      id: principal.userId,
      email: principal.email,
      displayName: principal.displayName,
    },
    tenant: {
      id: principal.tenantId,
      ...(principal.tenantSlug === '' ? {} : { slug: principal.tenantSlug }),
    },
    session: { id: principal.sessionId },
    roles: principal.roles,
    permissions: principal.permissions,
    maxDiscountBasisPoints: principal.maxDiscountBasisPoints.toString(),
    branchId: principal.branchId,
  };
}

export interface NativeAuthRouteOptions {
  readonly service: NativeAuthService;
  readonly offlineLease?: OfflineLeaseService;
  readonly challengeAdmission?: LoginAdmissionController;
  readonly loginAdmission?: LoginAdmissionController;
}

export function registerNativeAuthRoutes(
  app: FastifyInstance,
  options: NativeAuthRouteOptions,
): void {
  const challengeAdmission =
    options.challengeAdmission ?? createLoginAdmissionController(NATIVE_CHALLENGE_ADMISSION_POLICY);
  const loginAdmission =
    options.loginAdmission ?? createLoginAdmissionController(NATIVE_LOGIN_ADMISSION_POLICY);

  app.post('/v1/native-auth/challenge', async (request, reply) => {
    const parsed = challengeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const permit = challengeAdmission.admit(parsed.data.tenantId, parsed.data.deviceEnrollmentId);
    if (!permit.allowed) {
      request.log.warn({ reason: permit.reason }, 'native challenge admission refused');
      reply.header('retry-after', String(permit.retryAfterSeconds));
      return reply.code(429).send(TOO_MANY_REQUESTS);
    }

    try {
      const result = await options.service.issueChallenge(parsed.data);
      if (result.outcome === 'failure') {
        request.log.info({ reason: result.reason }, 'native challenge refused');
        return reply.code(403).send(DEVICE_REFUSED);
      }
      return reply.code(200).send({
        challengeId: result.challengeId,
        tenantId: result.tenantId,
        deviceEnrollmentId: result.deviceEnrollmentId,
        terminalId: result.terminalId,
        branchId: result.branchId,
        expiresAt: result.expiresAt,
        signingPayload: result.signingPayload,
      });
    } finally {
      permit.release();
    }
  });

  app.post('/v1/native-auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(401).send(UNAUTHENTICATED);

    const permit = loginAdmission.admit(parsed.data.tenantId, parsed.data.email);
    if (!permit.allowed) {
      request.log.warn({ reason: permit.reason }, 'native login admission refused');
      reply.header('retry-after', String(permit.retryAfterSeconds));
      return reply.code(429).send(TOO_MANY_REQUESTS);
    }

    try {
      const result = await options.service.login(parsed.data);
      if (result.outcome === 'failure') {
        request.log.info({ reason: result.reason }, 'native login refused');
        return reply.code(401).send(UNAUTHENTICATED);
      }
      return reply.code(200).send({
        token: result.token,
        expiresAt: result.expiresAt,
        principal: safePrincipal(result.principal),
        binding: result.binding,
      });
    } finally {
      permit.release();
    }
  });

  app.get('/v1/native-auth/me', async (request, reply) => {
    const token = readNativeAuthorization(request.headers.authorization);
    if (token === null) return reply.code(401).send(UNAUTHENTICATED);
    const result = await options.service.authenticate(token);
    if (result.outcome === 'failure') {
      request.log.info({ reason: result.reason }, 'native session rejected');
      return reply.code(401).send(UNAUTHENTICATED);
    }
    return reply.code(200).send({
      principal: safePrincipal(result.principal),
      binding: result.binding,
    });
  });

  app.post('/v1/native-auth/offline-lease', async (request, reply) => {
    const token = readNativeAuthorization(request.headers.authorization);
    if (token === null) return reply.code(401).send(UNAUTHENTICATED);
    if (options.offlineLease === undefined) {
      return reply.code(503).send({ error: 'offline_lease_unavailable' });
    }
    const result = await options.offlineLease.issue(token);
    if (result.outcome === 'failure') {
      if (result.reason === 'unauthenticated') return reply.code(401).send(UNAUTHENTICATED);
      if (result.reason === 'commercial-inactive') {
        return reply.code(403).send({ error: 'offline_lease_refused' });
      }
      return reply.code(503).send({ error: 'offline_lease_unavailable' });
    }
    return reply.code(200).send({
      lease: result.lease,
      claims: result.claims,
      verificationKeySpki: result.verificationKeySpki,
    });
  });

  app.post('/v1/native-auth/logout', async (request, reply) => {
    const token = readNativeAuthorization(request.headers.authorization);
    if (token !== null) await options.service.logout(token);
    return reply.code(204).send();
  });
}
