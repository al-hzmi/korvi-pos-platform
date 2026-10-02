import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type {
  MerchantCustomerMigrationService,
  CustomerSourceInspection,
} from '../migration/customer-import-service.js';
import type { AuthService } from '../auth/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { CustomerImportSummary } from '@korvi/database';
import type { FastifyInstance } from 'fastify';

const TENANT = '018fb700-0000-7000-8000-00000000000a';
const USER = '018fb700-0000-7000-8000-0000000000a1';
const JOB = '018fb700-0000-7000-8000-0000000000b1';
const OP = '018fb700-0000-7000-8000-0000000000c1';
const COOKIE = 'korvi_session=migration-test-token';
const ORIGIN = 'http://localhost:3000';

let app: FastifyInstance | null = null;
let calls: Array<{ readonly method: string; readonly value: unknown }> = [];

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT,
    tenantSlug: 'merchant-a',
    userId: USER,
    sessionId: '018fb700-0000-7000-8000-0000000000aa',
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
      return token === 'migration-test-token'
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

const summary: CustomerImportSummary = {
  id: JOB,
  domain: 'customers',
  format: 'csv',
  sourceFileName: 'customers.csv',
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
  updated: 0,
  failed: 0,
  rejected: 0,
  rows: [],
  rowsTruncated: false,
  createdAt: '2026-09-20T12:00:00.000Z',
  dryRunAt: null,
  commitAt: null,
};

const inspection: CustomerSourceInspection = {
  sourceSha256: 'a'.repeat(64),
  fileBytes: 50,
  totalRows: 1,
  header: [],
  mappingIssues: [],
  previewRows: [],
};

function service(): MerchantCustomerMigrationService {
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
      return {
        outcome: 'success',
        value: { ...summary, format: 'xlsx', sourceFileName: 'customers.xlsx' },
      };
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
    customerMigration: service(),
  });
  return app;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('customer migration HTTP authority', () => {
  it('requires settings.manage before inspection and never calls the service on refusal', async () => {
    const server = build(principal(['customer.write']));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/customers/inspect-csv',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        csvText: 'اسم العميل,رقم الجوال,البريد الإلكتروني\\nشركة ألف,0500000000,a@example.com',
      },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('rejects request-controlled tenant and source hash authority', async () => {
    const server = build(principal(['settings.manage']));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/customers/jobs',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        csvText: 'اسم العميل,رقم الجوال,البريد الإلكتروني\\nشركة ألف,0500000000,a@example.com',
        mapping: [],
        tenantId: TENANT,
        sourceSha256: 'b'.repeat(64),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('exposes bounded inspection and creates only a reviewed import job', async () => {
    const server = build(principal(['settings.manage']));
    const inspect = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/customers/inspect-csv',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        csvText: 'اسم العميل,رقم الجوال,البريد الإلكتروني\\nشركة ألف,0500000000,a@example.com',
        fileName: 'customers.csv',
      },
    });
    const create = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/customers/jobs',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        csvText: 'اسم العميل,رقم الجوال,البريد الإلكتروني\\nشركة ألف,0500000000,a@example.com',
        fileName: 'customers.csv',
        mapping: [],
      },
    });
    expect(inspect.statusCode).toBe(200);
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ id: JOB, status: 'reviewed', created: 0 });
    expect(calls.map((call) => call.method)).toEqual(['inspectCsv', 'createCsvJob']);
  });

  it('routes XLSX inspection and reviewed jobs through the same tenant-scoped authority', async () => {
    const server = build(principal(['settings.manage']));
    const xlsxBase64 = Buffer.from('xlsx-fixture').toString('base64');

    const inspect = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/customers/inspect-xlsx',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { xlsxBase64, fileName: 'customers.xlsx' },
    });
    const create = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/customers/jobs/xlsx',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        xlsxBase64,
        fileName: 'customers.xlsx',
        mapping: [],
      },
    });

    expect(inspect.statusCode).toBe(200);
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({
      id: JOB,
      status: 'reviewed',
      format: 'xlsx',
      sourceFileName: 'customers.xlsx',
    });
    expect(calls.map((call) => call.method)).toEqual(['inspectXlsx', 'createXlsxJob']);
    expect(calls[0]?.value).not.toHaveProperty('tenantId');
    expect(calls[1]?.value).not.toHaveProperty('sourceSha256');
  });

  it('pages row results without tenant-controlled scope', async () => {
    const server = build(principal(['settings.manage']));
    const response = await server.inject({
      method: 'GET',
      url: `/v1/admin/migrations/customers/jobs/${JOB}/rows?limit=50&afterSourceRow=100&problemsOnly=true`,
      headers: { cookie: COOKIE },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rows: [], nextAfterSourceRow: null });
    expect(calls).toEqual([
      {
        method: 'rows',
        value: {
          jobId: JOB,
          options: { limit: 50, afterSourceRow: 100, problemsOnly: true },
        },
      },
    ]);
  });

  it('keeps dry-run separate from commit and commit requires customer.write too', async () => {
    const manageOnly = build(principal(['settings.manage']));
    const dry = await manageOnly.inject({
      method: 'POST',
      url: `/v1/admin/migrations/customers/jobs/${JOB}/dry-run`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {},
    });
    const deniedCommit = await manageOnly.inject({
      method: 'POST',
      url: `/v1/admin/migrations/customers/jobs/${JOB}/commit`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: OP },
    });
    expect(dry.statusCode).toBe(200);
    expect(deniedCommit.statusCode).toBe(403);
    expect(calls.map((call) => call.method)).toEqual(['dryRun']);
    await manageOnly.close();
    app = null;

    const authorized = build(principal(['settings.manage', 'customer.write']));
    const committed = await authorized.inject({
      method: 'POST',
      url: `/v1/admin/migrations/customers/jobs/${JOB}/commit`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: OP },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({ id: JOB, status: 'completed', created: 1 });
    expect(calls).toEqual([{ method: 'commit', value: { jobId: JOB, operationId: OP } }]);
  });

  it('accepts only the explicit update-by-phone strategy and never customerId authority', async () => {
    const server = build(principal(['settings.manage']));
    const allowed = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/customers/jobs',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        csvText: 'اسم العميل,رقم الجوال\\nشركة ألف,0500000000',
        mapping: [
          { sourceColumn: 0, targetField: 'nameAr' },
          { sourceColumn: 1, targetField: 'phone' },
        ],
        conflictPolicy: 'update-existing-by-phone',
      },
    });
    expect(allowed.statusCode).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.value).toMatchObject({
      conflictPolicy: 'update-existing-by-phone',
    });

    for (const forged of [
      { conflictPolicy: 'update-by-name' },
      { customerId: '018fb700-0000-7000-8000-0000000000ff' },
    ]) {
      calls = [];
      const response = await server.inject({
        method: 'POST',
        url: '/v1/admin/migrations/customers/jobs',
        headers: { cookie: COOKIE, origin: ORIGIN },
        payload: {
          operationId: '018fb700-0000-7000-8000-0000000000d1',
          csvText: 'اسم العميل,رقم الجوال\\nشركة ألف,0500000000',
          mapping: [
            { sourceColumn: 0, targetField: 'nameAr' },
            { sourceColumn: 1, targetField: 'phone' },
          ],
          ...forged,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(calls).toEqual([]);
    }
  });
});
