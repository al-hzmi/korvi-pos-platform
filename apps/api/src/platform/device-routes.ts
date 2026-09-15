import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { PlatformDeviceEnrollmentRefusedError } from '@korvi/database/device-enrollment';
import {
  issuePlatformDeviceEnrollment,
  issuePlatformDeviceRevocation,
  PlatformDeviceEnrollmentUnavailableError,
} from './device-enrollment-issuer.js';
import type { DeviceEnrollmentRecord } from '@korvi/database/device-enrollment';
import type { PlatformAuth, PlatformPrincipal } from './auth.js';
import type { PlatformDeviceEnrollmentInput, PlatformDeviceRevocationInput } from './device-enrollment-issuer.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

const tenantParams = z.object({ tenantId: z.string().uuid() }).strict();
const enrollmentParams = z
  .object({ tenantId: z.string().uuid(), enrollmentId: z.string().uuid() })
  .strict();
const sha256Hex = z.string().regex(/^[0-9a-fA-F]{64}$/);
const canonicalBase64 = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => Buffer.from(value, 'base64').toString('base64') === value);
const enrollmentBody = z
  .object({
    operationId: z.string().trim().min(1).max(160),
    terminalId: z.string().uuid(),
    installationId: z.string().uuid(),
    platform: z.enum(['windows', 'android']),
    normalizedFingerprintDigest: sha256Hex,
    publicKeySpki: canonicalBase64,
    publicKeySha256: sha256Hex,
    keyAlgorithm: z.enum(['ed25519', 'p256']),
    appVersion: z.string().trim().min(1).max(64),
  })
  .strict();
const revocationBody = z
  .object({
    operationId: z.string().trim().min(1).max(160),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export interface PlatformDeviceRouteOptions {
  readonly auth: PlatformAuth;
  readonly enroll?: typeof issuePlatformDeviceEnrollment;
  readonly revoke?: typeof issuePlatformDeviceRevocation;
}

function subject(request: { platformAuth?: PlatformPrincipal }): PlatformPrincipal {
  if (request.platformAuth === undefined) {
    throw new Error('Platform device route executed without authenticated principal.');
  }
  return request.platformAuth;
}

function wireEnrollment(enrollment: DeviceEnrollmentRecord) {
  return {
    ...enrollment,
    enrolledAt: enrollment.enrolledAt.toISOString(),
    lastSeenAt: enrollment.lastSeenAt.toISOString(),
    revokedAt: enrollment.revokedAt?.toISOString() ?? null,
  };
}

function handleDeviceError(reply: FastifyReply, error: unknown): FastifyReply | null {
  if (error instanceof PlatformDeviceEnrollmentUnavailableError) {
    return reply.code(503).send({ error: 'device_enrollment_unavailable' });
  }
  if (!(error instanceof PlatformDeviceEnrollmentRefusedError)) return null;

  if (
    error.detail === 'unknown-tenant' ||
    error.detail === 'unknown-terminal' ||
    error.detail === 'unknown-enrollment'
  ) {
    return reply.code(404).send({ error: error.detail.replace(/-/g, '_') });
  }
  if (error.detail === 'invalid-input') {
    return reply.code(422).send({ error: 'invalid_input' });
  }
  return reply.code(409).send({ error: error.detail.replace(/-/g, '_') });
}

export function registerPlatformDeviceRoutes(
  app: FastifyInstance,
  options: PlatformDeviceRouteOptions,
): void {
  const enroll = options.enroll ?? issuePlatformDeviceEnrollment;
  const revoke = options.revoke ?? issuePlatformDeviceRevocation;
  const canManageDevices = [
    options.auth.requireSession,
    options.auth.requirePermission('platform.tenants.manage'),
  ];

  app.post(
    '/v1/platform/tenants/:tenantId/device-enrollments',
    { preHandler: canManageDevices },
    async (request, reply) => {
      const params = tenantParams.safeParse(request.params);
      const body = enrollmentBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      const input: PlatformDeviceEnrollmentInput = {
        operationId: body.data.operationId,
        terminalId: body.data.terminalId,
        installationId: body.data.installationId,
        platform: body.data.platform,
        normalizedFingerprintDigest: body.data.normalizedFingerprintDigest.toLowerCase(),
        publicKeySpki: Buffer.from(body.data.publicKeySpki, 'base64'),
        publicKeySha256: body.data.publicKeySha256.toLowerCase(),
        keyAlgorithm: body.data.keyAlgorithm,
        appVersion: body.data.appVersion,
      };

      try {
        const result = await enroll(subject(request), params.data.tenantId, input);
        return reply.code(result.replayed ? 200 : 201).send({
          enrollment: wireEnrollment(result.enrollment),
          replayed: result.replayed,
        });
      } catch (error) {
        const handled = handleDeviceError(reply, error);
        if (handled !== null) return handled;
        throw error;
      }
    },
  );

  app.post(
    '/v1/platform/tenants/:tenantId/device-enrollments/:enrollmentId/revoke',
    { preHandler: canManageDevices },
    async (request, reply) => {
      const params = enrollmentParams.safeParse(request.params);
      const body = revocationBody.safeParse(request.body);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      if (!body.success) return reply.code(400).send({ error: 'invalid_body' });

      const input: PlatformDeviceRevocationInput = body.data;
      try {
        const result = await revoke(
          subject(request),
          params.data.tenantId,
          params.data.enrollmentId,
          input,
        );
        return reply.code(200).send({
          enrollment: wireEnrollment(result.enrollment),
          replayed: result.replayed,
        });
      } catch (error) {
        const handled = handleDeviceError(reply, error);
        if (handled !== null) return handled;
        throw error;
      }
    },
  );
}
