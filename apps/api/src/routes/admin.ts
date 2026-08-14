import {
  activationBody,
  adminListQuery,
  branchCreateBody,
  branchParams,
  branchPatchBody,
  memberCreateBody,
  memberParams,
  memberPatchBody,
  memberRoleParams,
  namesAdminAuthorityField,
  roleAssignmentBody,
  settingsPatchBody,
  terminalCreateBody,
  terminalListQuery,
  terminalParams,
  terminalPatchBody,
} from './admin-validation.js';
import type { AdminFailureReason, AdminResult, MerchantAdminService } from '../admin/service.js';
import type { Guards } from '../auth/guards.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The merchant's own administration surface.
 *
 * Everything under `/v1/admin` is the merchant administering the merchant.
 * Nothing here reaches Korvi's control plane: `provisionTenant`,
 * `activateTenant`, `suspendTenant` and `reactivateTenant` are not imported,
 * not wrapped, and not reachable — a merchant owner is not a platform operator
 * and there is no route that lets one become the other (ADR-0018, ADR-0019).
 *
 * Every route derives the tenant and the actor from `request.auth`, which the
 * session guard filled in from the database. The service's signatures make that
 * structural rather than habitual: no method on it takes a tenant id.
 *
 * Two permissions govern the surface, and they are the ones the RBAC model
 * already defines. `settings.manage` covers the shop's own configuration —
 * settings, branches, tills. `users.manage` covers people and what they may do.
 * Neither is a new authorization system; both are checked by the existing
 * guard against permissions read from persistence on every request.
 */

const UNAUTHENTICATED = { error: 'unauthenticated' } as const;

/**
 * Arabic, because the person reading it is an owner looking at their own shop.
 *
 * `unknown_*` is deliberately the same answer for a row that belongs to another
 * merchant as for one that does not exist. An administrator who guesses an id
 * learns nothing about anybody else's shop from either the status or the body.
 */
const MESSAGES: Readonly<Record<AdminFailureReason, string>> = {
  'unknown-branch': 'الفرع غير معروف.',
  'unknown-terminal': 'الصندوق غير معروف.',
  'unknown-member': 'المستخدم غير معروف.',
  'unknown-role': 'الدور غير معروف.',
  'code-taken': 'الرمز مستخدم بالفعل في هذه المنشأة.',
  'email-taken': 'البريد الإلكتروني مستخدم بالفعل في هذه المنشأة.',
  'branch-in-use': 'لا يمكن التعطيل الآن: توجد وردية مفتوحة. أغلق الوردية أولاً.',
  'branch-inactive': 'الفرع معطّل. فعّل الفرع أولاً.',
  'invalid-cursor': 'مؤشر الصفحة غير صالح. ابدأ من الصفحة الأولى.',
  'last-administrator': 'لا يمكن تنفيذ هذا التغيير: لن يبقى من يدير هذه المنشأة.',
  'invalid-input': 'البيانات المرسلة غير صالحة.',
};

const STATUS: Readonly<Record<AdminFailureReason, number>> = {
  'unknown-branch': 404,
  'unknown-terminal': 404,
  'unknown-member': 404,
  'unknown-role': 404,
  // A retry with a different code or address resolves these.
  'code-taken': 409,
  'email-taken': 409,
  // The state of the shop, not the shape of the request.
  'branch-in-use': 409,
  // Not "in use": nothing is open, the parent branch is simply stood down, and
  // the remedy is to activate it rather than to close a drawer.
  'branch-inactive': 409,
  'invalid-cursor': 400,
  'last-administrator': 409,
  'invalid-input': 422,
};

export interface AdminRouteOptions {
  readonly service: MerchantAdminService;
  readonly guards: Guards;
}

function principalOf(request: FastifyRequest): AuthenticatedPrincipal | undefined {
  return request.auth;
}

/**
 * One place where a failed operation becomes a response.
 *
 * The result type makes it impossible to forget: a route cannot reach the
 * success branch without having narrowed the union, so there is no path on
 * which a refusal is answered `200`.
 */
function respond<T>(reply: FastifyReply, result: AdminResult<T>, code = 200): FastifyReply {
  if (result.outcome === 'failure') {
    return reply
      .code(STATUS[result.reason])
      .send({ error: result.reason.replace(/-/g, '_'), message: MESSAGES[result.reason] });
  }
  return reply.code(code).send(result.value);
}

/**
 * Refuse a body that asserts authority, before it is parsed.
 *
 * Every schema is `.strict()` and would reject these as unrecognised keys. This
 * runs first so the log line and the response name the actual problem — a
 * client trying to set `tenantId` has a bug worth seeing as a bug.
 */
function assertsAuthority(reply: FastifyReply, body: unknown): boolean {
  const field = namesAdminAuthorityField(body);
  if (field === null) return false;
  void reply.code(400).send({ error: 'forbidden_field', field });
  return true;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRouteOptions): void {
  const { service, guards } = options;

  const settingsGuard = [guards.requireSession, guards.requirePermission('settings.manage')];
  const usersGuard = [guards.requireSession, guards.requirePermission('users.manage')];

  // -------------------------------------------------------------------------
  // Tenant settings
  // -------------------------------------------------------------------------

  app.get('/v1/admin/settings', { preHandler: settingsGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
    return respond(reply, await service.readSettings(principal));
  });

  app.patch('/v1/admin/settings', { preHandler: settingsGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
    if (assertsAuthority(reply, request.body)) return reply;

    const parsed = settingsPatchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    return respond(reply, await service.updateSettings(principal, parsed.data));
  });

  // -------------------------------------------------------------------------
  // Branches
  // -------------------------------------------------------------------------

  app.get('/v1/admin/branches', { preHandler: settingsGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);

    const parsed = adminListQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    return respond(
      reply,
      await service.listBranches(principal, parsed.data.limit, parsed.data.cursor ?? null),
    );
  });

  app.post('/v1/admin/branches', { preHandler: settingsGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
    if (assertsAuthority(reply, request.body)) return reply;

    const parsed = branchCreateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    return respond(reply, await service.createBranch(principal, parsed.data), 201);
  });

  app.patch(
    '/v1/admin/branches/:branchId',
    { preHandler: settingsGuard },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
      if (assertsAuthority(reply, request.body)) return reply;

      const params = branchParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const parsed = branchPatchBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      return respond(
        reply,
        await service.updateBranch(principal, params.data.branchId, parsed.data),
      );
    },
  );

  app.post(
    '/v1/admin/branches/:branchId/activation',
    { preHandler: settingsGuard },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
      if (assertsAuthority(reply, request.body)) return reply;

      const params = branchParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const parsed = activationBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      return respond(
        reply,
        await service.setBranchActive(principal, params.data.branchId, parsed.data.isActive),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Terminals
  // -------------------------------------------------------------------------

  app.get('/v1/admin/terminals', { preHandler: settingsGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);

    const parsed = terminalListQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    return respond(
      reply,
      await service.listTerminals(
        principal,
        parsed.data.limit,
        parsed.data.branchId ?? null,
        parsed.data.cursor ?? null,
      ),
    );
  });

  app.post('/v1/admin/terminals', { preHandler: settingsGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
    if (assertsAuthority(reply, request.body)) return reply;

    const parsed = terminalCreateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    return respond(reply, await service.createTerminal(principal, parsed.data), 201);
  });

  app.patch(
    '/v1/admin/terminals/:terminalId',
    { preHandler: settingsGuard },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
      if (assertsAuthority(reply, request.body)) return reply;

      const params = terminalParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const parsed = terminalPatchBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      return respond(
        reply,
        await service.updateTerminal(principal, params.data.terminalId, parsed.data.label),
      );
    },
  );

  app.post(
    '/v1/admin/terminals/:terminalId/activation',
    { preHandler: settingsGuard },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
      if (assertsAuthority(reply, request.body)) return reply;

      const params = terminalParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const parsed = activationBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      return respond(
        reply,
        await service.setTerminalActive(principal, params.data.terminalId, parsed.data.isActive),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Members
  // -------------------------------------------------------------------------

  app.get('/v1/admin/members', { preHandler: usersGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);

    const parsed = adminListQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    return respond(
      reply,
      await service.listMembers(principal, parsed.data.limit, parsed.data.cursor ?? null),
    );
  });

  app.post('/v1/admin/members', { preHandler: usersGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
    if (assertsAuthority(reply, request.body)) return reply;

    const parsed = memberCreateBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    return respond(reply, await service.createMember(principal, parsed.data), 201);
  });

  app.patch('/v1/admin/members/:userId', { preHandler: usersGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
    // `userId` is a path parameter and not a body field, which is why the
    // forbidden-field check below still refuses it in a body: the two would
    // otherwise disagree about which one the server believed.
    if (assertsAuthority(reply, request.body)) return reply;

    const params = memberParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const parsed = memberPatchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

    return respond(reply, await service.updateMember(principal, params.data.userId, parsed.data));
  });

  app.post(
    '/v1/admin/members/:userId/user-activation',
    { preHandler: usersGuard },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
      if (assertsAuthority(reply, request.body)) return reply;

      const params = memberParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const parsed = activationBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      return respond(
        reply,
        await service.setUserActive(principal, params.data.userId, parsed.data.isActive),
      );
    },
  );

  app.post(
    '/v1/admin/members/:userId/membership-activation',
    { preHandler: usersGuard },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
      if (assertsAuthority(reply, request.body)) return reply;

      const params = memberParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      const parsed = activationBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      return respond(
        reply,
        await service.setMembershipActive(principal, params.data.userId, parsed.data.isActive),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  app.get('/v1/admin/roles', { preHandler: usersGuard }, async (request, reply) => {
    const principal = principalOf(request);
    if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
    return respond(reply, await service.listRoles(principal));
  });

  app.post(
    '/v1/admin/members/:userId/roles',
    { preHandler: usersGuard },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);
      if (assertsAuthority(reply, request.body)) return reply;

      const params = memberParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
      // A role id, and never a permission list. The unit of grant is a role,
      // which is what keeps "what may this person do" answerable in one place.
      const parsed = roleAssignmentBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });

      return respond(
        reply,
        await service.assignRole(principal, params.data.userId, parsed.data.roleId),
      );
    },
  );

  app.delete(
    '/v1/admin/members/:userId/roles/:roleId',
    { preHandler: usersGuard },
    async (request, reply) => {
      const principal = principalOf(request);
      if (principal === undefined) return reply.code(401).send(UNAUTHENTICATED);

      const params = memberRoleParams.safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid_params' });

      return respond(
        reply,
        await service.removeRole(principal, params.data.userId, params.data.roleId),
      );
    },
  );
}
