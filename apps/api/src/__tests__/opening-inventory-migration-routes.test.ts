import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../server.js';
import { loadConfig } from '../config.js';
import type {
  MerchantOpeningInventoryMigrationService,
  OpeningInventorySourceInspection,
} from '../migration/opening-inventory-import-service.js';
import type { AuthService } from '../auth/service.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';
import type { OpeningInventoryImportSummary } from '@korvi/database';
import type { FastifyInstance } from 'fastify';

const TENANT = '018fbe00-0000-7000-8000-00000000000a';
const USER = '018fbe00-0000-7000-8000-0000000000a1';
const JOB = '018fbe00-0000-7000-8000-0000000000b1';
const OP = '018fbe00-0000-7000-8000-0000000000c1';
const COOKIE = 'korvi_session=migration-test-token';
const ORIGIN = 'http://localhost:3000';

let app: FastifyInstance | null = null;
let calls: Array<{ readonly method: string; readonly value: unknown }> = [];

function principal(permissions: AuthenticatedPrincipal['permissions']): AuthenticatedPrincipal {
  return {
    tenantId: TENANT,
    tenantSlug: 'merchant-a',
    userId: USER,
    sessionId: '018fbe00-0000-7000-8000-0000000000aa',
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

const summary: OpeningInventoryImportSummary = {
  id: JOB,
  domain: 'opening-inventory',
  format: 'csv',
  sourceFileName: 'opening-stock.csv',
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
  createdAt: '2026-09-22T00:00:00.000Z',
  dryRunAt: null,
  commitAt: null,
};

const inspection: OpeningInventorySourceInspection = {
  sourceSha256: 'a'.repeat(64),
  fileBytes: 64,
  totalRows: 1,
  header: [],
  mappingIssues: [],
  previewRows: [],
};

function service(): MerchantOpeningInventoryMigrationService {
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
        value: { ...summary, format: 'xlsx', sourceFileName: 'opening-stock.xlsx' },
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
    openingInventoryMigration: service(),
  });
  return app;
}

afterEach(async () => {
  if (app !== null) await app.close();
  app = null;
});

describe('opening inventory migration HTTP authority', () => {
  it('requires settings.manage before inspection', async () => {
    const server = build(principal(['inventory.adjust']));
    const response = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/opening-inventory/inspect-csv',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { csvText: 'كود الفرع,SKU,الكمية الافتتاحية\\nMAIN,A1,12' },
    });
    expect(response.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('rejects tenant, UUID, source-hash and cost authority from the client', async () => {
    const server = build(principal(['settings.manage', 'inventory.adjust']));
    const attempts = [
      { tenantId: TENANT },
      { sourceSha256: 'b'.repeat(64) },
      { branchId: '018fbe00-0000-7000-8000-0000000000d1' },
      { productId: '018fbe00-0000-7000-8000-0000000000d2' },
      { inventoryValueMinor: '1000' },
    ];
    for (const forged of attempts) {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/admin/migrations/opening-inventory/jobs',
        headers: { cookie: COOKIE, origin: ORIGIN },
        payload: {
          operationId: OP,
          csvText: 'كود الفرع,SKU,الكمية الافتتاحية\\nMAIN,A1,12',
          mapping: [
            { sourceColumn: 0, targetField: 'branchCode' },
            { sourceColumn: 1, targetField: 'sku' },
            { sourceColumn: 2, targetField: 'openingQuantity' },
          ],
          ...forged,
        },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('rejects UUID-style target fields from mapping authority', async () => {
    const server = build(principal(['settings.manage']));
    for (const targetField of ['branchId', 'productId', 'costMinor']) {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/admin/migrations/opening-inventory/jobs',
        headers: { cookie: COOKIE, origin: ORIGIN },
        payload: {
          operationId: OP,
          csvText: 'كود الفرع,SKU,الكمية الافتتاحية\\nMAIN,A1,12',
          mapping: [{ sourceColumn: 0, targetField }],
        },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('supports bounded CSV and XLSX inspection and reviewed jobs', async () => {
    const server = build(principal(['settings.manage']));
    const csv = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/opening-inventory/inspect-csv',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        csvText: 'كود الفرع,SKU,الكمية الافتتاحية\\nMAIN,A1,12',
        fileName: 'opening-stock.csv',
      },
    });
    const created = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/opening-inventory/jobs',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {
        operationId: OP,
        csvText: 'كود الفرع,SKU,الكمية الافتتاحية\\nMAIN,A1,12',
        fileName: 'opening-stock.csv',
        mapping: [],
      },
    });
    const xlsxBase64 = Buffer.from('xlsx-fixture').toString('base64');
    const xlsx = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/opening-inventory/inspect-xlsx',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { xlsxBase64, fileName: 'opening-stock.xlsx' },
    });
    const xlsxCreated = await server.inject({
      method: 'POST',
      url: '/v1/admin/migrations/opening-inventory/jobs/xlsx',
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: OP, xlsxBase64, fileName: 'opening-stock.xlsx', mapping: [] },
    });

    expect(csv.statusCode).toBe(200);
    expect(created.statusCode).toBe(201);
    expect(xlsx.statusCode).toBe(200);
    expect(xlsxCreated.statusCode).toBe(201);
    expect(calls.map((call) => call.method)).toEqual([
      'inspectCsv',
      'createCsvJob',
      'inspectXlsx',
      'createXlsxJob',
    ]);
  });

  it('keeps dry-run separate and requires inventory.adjust for commit', async () => {
    const manageOnly = build(principal(['settings.manage']));
    const dry = await manageOnly.inject({
      method: 'POST',
      url: `/v1/admin/migrations/opening-inventory/jobs/${JOB}/dry-run`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: {},
    });
    const denied = await manageOnly.inject({
      method: 'POST',
      url: `/v1/admin/migrations/opening-inventory/jobs/${JOB}/commit`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: OP },
    });
    expect(dry.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
    expect(calls.map((call) => call.method)).toEqual(['dryRun']);
    await manageOnly.close();
    app = null;

    const purchasingOnly = build(principal(['settings.manage', 'purchasing.manage']));
    const stillDenied = await purchasingOnly.inject({
      method: 'POST',
      url: `/v1/admin/migrations/opening-inventory/jobs/${JOB}/commit`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: OP },
    });
    expect(stillDenied.statusCode).toBe(403);
    expect(calls).toEqual([]);
    await purchasingOnly.close();
    app = null;

    const authorized = build(principal(['settings.manage', 'inventory.adjust']));
    const committed = await authorized.inject({
      method: 'POST',
      url: `/v1/admin/migrations/opening-inventory/jobs/${JOB}/commit`,
      headers: { cookie: COOKIE, origin: ORIGIN },
      payload: { operationId: OP },
    });
    expect(committed.statusCode).toBe(200);
    expect(committed.json()).toMatchObject({ status: 'completed', created: 1 });
    expect(calls).toEqual([{ method: 'commit', value: { jobId: JOB, operationId: OP } }]);
  });
});
