import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, tenantId } from '@korvi/domain';
import {
  ACCEPTED,
  CHECK_HASH,
  CREDENTIAL_ID,
  D,
  SECRET_ID,
  cleanupEvidenceFixture,
  inTenant,
  setupEvidenceFixture,
} from './zatca-compliance-evidence-live-fixture.js';
import type { EvidenceLiveFixture } from './zatca-compliance-evidence-live-fixture.js';

const appUrl = process.env['KORVI_TEST_DATABASE_URL'] ?? '';
const adminUrl = process.env['KORVI_TEST_ADMIN_DATABASE_URL'] ?? '';

const canonicalInput = {
  evidenceId: D.evidence,
  terminalId: D.terminalA,
  complianceAttemptId: D.issuedAttempt,
  checkSetHash: CHECK_HASH,
  acceptedAt: ACCEPTED,
} as const;

describe.skipIf(appUrl === '' || adminUrl === '')(
  'ZATCA accepted compliance evidence, PostgreSQL live',
  () => {
    let fixture: EvidenceLiveFixture;

    beforeAll(async () => {
      fixture = await setupEvidenceFixture(appUrl, adminUrl);
    });

    afterAll(async () => {
      await cleanupEvidenceFixture(fixture);
    });

    it('persists only accepted-check identity and derives every CCSID authority field', async () => {
      const stored = await fixture.evidence.recordAccepted(
        { tenantId: tenantId(D.tenantA) },
        canonicalInput,
      );
      expect(stored.environment).toBe('production');
      expect(stored.complianceRequestId).toBe(`request-${D.issuedAttempt}`);
      expect(stored.currentComplianceCredentialId).toBe(CREDENTIAL_ID);
      expect(stored.currentComplianceSecret).toEqual({
        provider: 'korvi-test-fatoora-vault',
        secretId: SECRET_ID,
      });
      expect(stored.key.keyId).toBe(`key-${D.issuedAttempt}`);
      expect(stored.key.exportable).toBe(false);

      const columns = await fixture.admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema='public' AND table_name='zatca_compliance_evidence'
         ORDER BY ordinal_position`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'id',
        'tenantId',
        'terminalId',
        'complianceAttemptId',
        'checkSetHash',
        'acceptedAt',
        'createdAt',
      ]);
    });

    it('is idempotent only for byte-for-byte identical accepted evidence', async () => {
      await expect(
        fixture.evidence.recordAccepted({ tenantId: tenantId(D.tenantA) }, canonicalInput),
      ).resolves.toMatchObject({ evidenceId: D.evidence, checkSetHash: CHECK_HASH });
      await expect(
        fixture.evidence.recordAccepted(
          { tenantId: tenantId(D.tenantA) },
          { ...canonicalInput, evidenceId: newId(), checkSetHash: '9'.repeat(64) },
        ),
      ).rejects.toThrow(/different accepted compliance evidence/);
    });

    it('fails closed for non-issued, wrong-terminal and pre-issuance evidence', async () => {
      await expect(
        fixture.evidence.recordAccepted(
          { tenantId: tenantId(D.tenantA) },
          {
            evidenceId: newId(),
            terminalId: D.terminalA,
            complianceAttemptId: D.preparedAttempt,
            checkSetHash: '1'.repeat(64),
            acceptedAt: ACCEPTED,
          },
        ),
      ).rejects.toThrow(/requires an issued same-terminal Compliance CSID/);
      await expect(
        fixture.evidence.recordAccepted(
          { tenantId: tenantId(D.tenantA) },
          {
            evidenceId: newId(),
            terminalId: D.terminalA,
            complianceAttemptId: D.earlyAttempt,
            checkSetHash: '2'.repeat(64),
            acceptedAt: '2026-09-10T22:50:01Z',
          },
        ),
      ).rejects.toThrow(/requires an issued same-terminal Compliance CSID/);
    });

    it('enforces RLS, append-only evidence, and source-attempt retention in PostgreSQL', async () => {
      await fixture.evidence.recordAccepted({ tenantId: tenantId(D.tenantA) }, canonicalInput);
      await expect(
        fixture.evidence.findById({ tenantId: tenantId(D.tenantB) }, D.evidence),
      ).resolves.toBeNull();

      await inTenant(fixture.app, D.tenantB, async () => {
        const rows = await fixture.app.query(
          'SELECT "id" FROM "zatca_compliance_evidence" WHERE "id"=$1::uuid',
          [D.evidence],
        );
        expect(rows.rowCount).toBe(0);
      });
      await expect(
        inTenant(fixture.app, D.tenantA, () =>
          fixture.app.query(
            'UPDATE "zatca_compliance_evidence" SET "checkSetHash"=$2 WHERE "id"=$1::uuid',
            [D.evidence, '7'.repeat(64)],
          ),
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        inTenant(fixture.app, D.tenantA, () =>
          fixture.app.query('DELETE FROM "zatca_compliance_evidence" WHERE "id"=$1::uuid', [
            D.evidence,
          ]),
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        inTenant(fixture.app, D.tenantA, () =>
          fixture.app.query('DELETE FROM "zatca_csid_provisioning_attempts" WHERE "id"=$1::uuid', [
            D.issuedAttempt,
          ]),
        ),
      ).rejects.toThrow();
      await expect(
        fixture.evidence.findById({ tenantId: tenantId(D.tenantA) }, D.evidence),
      ).resolves.toMatchObject({ evidenceId: D.evidence });
    });
  },
);
