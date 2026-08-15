import { z } from 'zod';
import { MAX_OWNER_BOOTSTRAP_TOKEN } from '@korvi/domain';
import type { OwnerBootstrapService } from '../bootstrap/service.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * The one public, unauthenticated write in Korvi.
 *
 * It exists because provisioning creates no merchant user (ADR-0018) and every
 * merchant surface needs a session, so somewhere there has to be a door that a
 * person with no account can walk through exactly once. This is it, and it is
 * deliberately the narrowest door in the system.
 *
 * The body is two fields. Not a tenant, not a user, not a role, not an email,
 * not a membership — the tenant arrives as a signed claim and everything else
 * is read from the invitation row under its own lock. `.strict()` refuses
 * anything else, and the named list below turns an attempt at authority into a
 * legible refusal rather than an "unrecognized key".
 *
 * The global origin hook still applies: this is a state-changing request, so a
 * browser that will not say where it came from does not get in.
 */

const bootstrapBody = z
  .object({
    token: z.string().min(1).max(MAX_OWNER_BOOTSTRAP_TOKEN),
    // Bounded here and validated for strength by the credential policy. The
    // bound is a denial-of-service control: scrypt over an unbounded input is
    // expensive on request.
    password: z.string().min(1).max(1024),
  })
  .strict();

/**
 * Authority a bootstrap request may never assert.
 *
 * `.strict()` already rejects each of them. They are named so the log line and
 * the response say what actually happened — a client sending `tenantId` here
 * has a bug worth seeing as a bug, and a client sending it deliberately should
 * be told the field is refused rather than left guessing.
 */
const FORBIDDEN_BOOTSTRAP_FIELDS = [
  'tenantId',
  'tenant',
  'tenantSlug',
  'userId',
  'roleId',
  'roleKey',
  'membershipId',
  'invitationId',
  'email',
  'displayName',
  'permissions',
  'roles',
  'status',
  'controlPlaneActorRef',
  'operationId',
  'expiresAt',
] as const;

function namesForbiddenField(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const field of FORBIDDEN_BOOTSTRAP_FIELDS) {
    if (Object.hasOwn(body, field)) return field;
  }
  return null;
}

/**
 * The single answer for every capability this server will not honour.
 *
 * Unknown, wrong tenant, consumed, expired, forged, wrong version, address
 * already credentialed, merchant already set up — one status and one body.
 * Telling them apart would make this endpoint an oracle for which merchants
 * exist and which invitations are outstanding, and the honest invitee learns
 * nothing from the distinction either way: they need a new invitation in every
 * one of those cases.
 */
const INVALID_CAPABILITY = { error: 'invalid_capability' } as const;

export interface BootstrapRouteOptions {
  /** Absent when no signing key is configured; the route then answers 503. */
  readonly service: OwnerBootstrapService | null;
}

export function registerBootstrapRoutes(
  app: FastifyInstance,
  options: BootstrapRouteOptions,
): void {
  const { service } = options;

  app.post('/v1/bootstrap/owner', async (request, reply): Promise<FastifyReply> => {
    if (service === null) {
      // A deployment that has not configured a signing key cannot serve this
      // safely. Saying so is an operator's problem, not a hint to a caller.
      request.log.error('owner bootstrap is not configured; BOOTSTRAP_SIGNING_KEY is missing');
      return reply.code(503).send({ error: 'unavailable' });
    }

    const field = namesForbiddenField(request.body);
    if (field !== null) {
      request.log.info({ field }, 'bootstrap request asserted authority');
      return reply.code(400).send({ error: 'forbidden_field', field });
    }

    const parsed = bootstrapBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    const result = await service.accept(parsed.data.token, parsed.data.password);
    if (result.outcome === 'failure') {
      if (result.reason === 'weak-password') {
        // A fact about the caller's own input. It is answered before the
        // capability is examined, so it reveals nothing about whether the
        // token would have been honoured.
        return reply.code(400).send({ error: 'weak_password' });
      }
      request.log.info('bootstrap capability refused');
      return reply.code(403).send(INVALID_CAPABILITY);
    }

    // No session, no cookie, no principal. The new Owner signs in through the
    // normal login path like everybody else; minting a session here would be a
    // second way to become authenticated, on the one route reachable without
    // being authenticated already.
    return reply.code(204).send();
  });
}
