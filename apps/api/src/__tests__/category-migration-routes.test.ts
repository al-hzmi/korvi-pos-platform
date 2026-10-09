import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type {
  CategorySourceInspection,
  MerchantCategoryMigrationService,
} from '../migration/category-import-service.js';
import type { AuthService } from '../auth/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { CategoryImportSummary } from '@korvi/database';
import type { FastifyInstance } from 'fastify';

const TENANT = '018fb710-0000-7000-8000-00000000000a';
const USER = '018fb710-0000-7000-8000-0000000000a1';
const JOB = '018fb710-0000-7000-8000-0000000000b1';
const OP = '018fb710-0000-7000-8000-0000000000c1';
const COOKIE = 'korvi_session=category-migration-test-token';
const ORIGIN = 'http://localhost:3000';

let app: FastifyInstance | null = null;
let calls: Array<{ readonly method: string; readonly value: unknown }> = [];

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT,
    tenantSlug: 'merchant-a',
    userId: USER,
    sessionId: '018fb710-0000-7000-8000-0000000000aa',
    email: 'admin@merchant.test',
    displayName: 'المشرف',
    roles: ['admin'],
    permissions,
    maxDiscountBasisPoints: 0n,
    branchId: null,
  };
}

function auth(subject: AuthenticatedPrincipal): AuthService {
  return {
    async login() {
      return { outcome: 'failure', reason: 'bad-password' };
    },
    async authenticate(token) {
      return token === 'category-migration-test-token'
        ? { outcome: 'success', principal: subject }
        : { outcome: 'failure', reason: 'malformed-token' };
    },
    async logout() {
      return true;
    },
    async logoutAll() {
      return 1;
    },
  };
}

const summary: CategoryImportSummary = {
  id: JOB,
  domain: 'categories',
  format: 'csv',
  sourceFileName: 'categories.csv',
  sourceSystem: null,
  sourceSha256: 'a'.repeat(64),
  status: 'reviewed',
  mappingVersion: 1,
  mapping: [],
  conflictPolicy: 'reject',
  totalRows: 1,
  validRows: 1,
  warningRows: 0,
  errorRows: 0,
  blockedRows: 0,
  created: 0,
  failed: 0,
  rejected: 0,
  rows: [],
  rowsTruncated: false,
  createdAt: '2026-09-21T12:00:00.000Z',
  dryRunAt: null,
  commitAt: null,
};

const inspection: CategorySourceInspection = {
  sourceSha256: 'a'.repeat(64),
  fileBytes: 40,
  totalRows: 1,
  header: [],
  mappingIssues: [],
  previewRows: [],
};

function service(): MerchantCategoryMigrationService {
  return {
    async inspectCsv(_principal, input) {
      calls.push({ method: 'inspectCsv', value: input });
      return { outcome: 'success', value: inspection };
    },
    async createCsvJob(_principal, request) {
      calls.push({ method: 'createCsvJob', value: request });
      return { outcome: 'success', value: summary };
    },
    async inspectXlsx(_principal, input) {
      calls.push({ method: 'inspectXlsx', value: input });
      return { outcome: 'success', value: inspection };
    },
    async createXlsxJob(_principal, request) {
      calls.push({ method: 'createXlsxJob', value: request });
      return { outcome: 'success', value: { ...summary, format: 'xlsx' } };
    },
    async readJob(_principal, jobId) {
      calls.push({ method: 'readJob', value: jobId });
      return { outcome: 'success', value: summary };
    },
    async rows(_principal, jobId, options) {
      calls.push({ method: 'rows', value: { jobId, options } });
      return { outcome: 'success', value: { rows: [], nextAfterSourceRow: null } };
    },
    async dryRun(_principal, jobId) {
      calls.push({ method: 'dryRun', value: jobId });
      return { outcome: 'success', value: { ...summary, status: 'dry-run' } };
    },
    async commit(_principal, jobId, operationId) {
      calls.push({ method: 'commit', value: { jobId, operationId } });
      return { outcome: 'success', value: { ...summary, status: 'completed', created: 1 } };
    },
  };
}

function build(subject: AuthenticatedPrincipal): FastifyInstance {
  calls = [];
  app = buildServer(loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'fatal' }), {
    auth: auth(subject),
    categoryMigration: service(),
  });
  return app;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('category migration HTTP authority', () => {
  it('requires settings.manage before inspection', async () => {
    const server = build(principal(['product.write']));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/categories/inspect-csv',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { csvText: 'اسم الفئة,الترتيب\nمشروبات,1' },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('rejects request-controlled tenant/source hash and creates only reviewed jobs', async () => {
    const server = build(principal(['settings.manage']));
    const rejected = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/categories/jobs',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        csvText: 'اسم الفئة,الترتيب\nمشروبات,1',
        mapping: [],
        tenantId: TENANT,
        sourceSha256: 'b'.repeat(64),
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect(calls).toEqual([]);

    const created = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/categories/jobs',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        csvText: 'اسم الفئة,الترتيب\nمشروبات,1',
        mapping: [],
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: JOB, status: 'reviewed', domain: 'categories' });
  });

  it('keeps dry-run separate from commit and requires product.write for commit', async () => {
    const manageOnly = build(principal(['settings.manage']));
    const dry = await manageOnly.inject({
      method: 'POST',
      url: `/v1/admin/migrations/categories/jobs/${JOB}/dry-run`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {},
    });
    const denied = await manageOnly.inject({
      method: 'POST',
      url: `/v1/admin/migrations/categories/jobs/${JOB}/commit`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: OP },
    });
    expect(dry.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
    expect(calls.map((call) => call.method)).toEqual(['dryRun']);
    await manageOnly.close();
    app = null;

    const authorized = build(principal(['settings.manage', 'product.write']));
    const committed = await authorized.inject({
      method: 'POST',
      url: `/v1/admin/migrations/categories/jobs/${JOB}/commit`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: OP },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({ status: 'completed', created: 1 });
  });
});
