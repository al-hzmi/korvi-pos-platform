import { z } from 'zod';
import { readNativeAuthorization } from '../native-auth/header.js';
import type { NativeAuthService } from '../native-auth/service.js';
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

export function registerNativeAuthRoutes(
  app: FastifyInstance,
  options: { readonly service: NativeAuthService },
): void {
  app.post('/v1/native-auth/challenge', async (request, reply) => {
    const parsed = challengeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
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
  });

  app.post('/v1/native-auth/login', async (request, reply) => {
    const parsed = loginBody.safeParse(request.body);
    if (!parsed.success) return reply.code(401).send(UNAUTHENTICATED);
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

  app.post('/v1/native-auth/logout', async (request, reply) => {
    const token = readNativeAuthorization(request.headers.authorization);
    if (token !== null) await options.service.logout(token);
    return reply.code(204).send();
  });
}
