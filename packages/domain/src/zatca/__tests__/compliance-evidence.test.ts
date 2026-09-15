import { describe, expect, it } from 'vitest';
import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  assertZatcaAcceptedComplianceEvidence,
  assertZatcaComplianceEvidenceAuthority,
  assertZatcaComplianceEvidenceRecordInput,
  tenantId,
  type ZatcaAcceptedComplianceEvidence,
} from '../../index.js';

const accepted = (): ZatcaAcceptedComplianceEvidence => ({
  evidenceId: '018f5c00-0000-7000-8000-0000000004a1',
  scope: { tenantId: tenantId('018f5c00-0000-7000-8000-0000000004a2') },
  terminalId: '018f5c00-0000-7000-8000-0000000004a3',
  complianceAttemptId: '018f5c00-0000-7000-8000-0000000004a4',
  environment: 'production',
  complianceRequestId: '123456789',
  currentComplianceCredentialId: `sha256:${'a'.repeat(64)}`,
  currentComplianceSecret: {
    provider: 'korvi-postgres-aes256gcm-v1',
    secretId: `sha256:${'a'.repeat(64)}`,
  },
  key: {
    provider: 'azure-key-vault',
    keyId: 'key-1',
    curve: ZATCA_SIGNING_CURVE,
    algorithm: ZATCA_SIGNING_ALGORITHM,
    exportable: false,
  },
  checkSetHash: 'b'.repeat(64),
  acceptedAt: '2026-09-10T22:40:00Z',
});

describe('ZATCA accepted compliance evidence', () => {
  it('accepts complete evidence bound to an issued-certificate identity and non-exportable key', () => {
    expect(() => assertZatcaAcceptedComplianceEvidence(accepted())).not.toThrow();
  });

  it('rejects malformed check fingerprints and non-second timestamps before persistence', () => {
    expect(() =>
      assertZatcaComplianceEvidenceRecordInput({
        evidenceId: 'evidence-1',
        terminalId: 'terminal-1',
        complianceAttemptId: 'attempt-1',
        checkSetHash: 'not-a-hash',
        acceptedAt: '2026-09-10T22:40:00Z',
      }),
    ).toThrow(/SHA-256/);
    expect(() =>
      assertZatcaComplianceEvidenceRecordInput({
        evidenceId: 'evidence-1',
        terminalId: 'terminal-1',
        complianceAttemptId: 'attempt-1',
        checkSetHash: 'b'.repeat(64),
        acceptedAt: '2026-09-10T22:40:00.123Z',
      }),
    ).toThrow(/exact UTC second/);
  });

  it('rejects evidence not backed by a certificate SHA-256 credential identity', () => {
    const evidence = { ...accepted(), currentComplianceCredentialId: 'credential-1' };
    expect(() => assertZatcaAcceptedComplianceEvidence(evidence)).toThrow(
      /certificate SHA-256 identity/,
    );
  });

  it('fails closed when tenant or terminal authority differs', () => {
    const evidence = accepted();
    expect(() =>
      assertZatcaComplianceEvidenceAuthority(
        evidence,
        { tenantId: tenantId('018f5c00-0000-7000-8000-0000000004ff') },
        evidence.terminalId,
      ),
    ).toThrow(/authority/);
    expect(() =>
      assertZatcaComplianceEvidenceAuthority(evidence, evidence.scope, 'other-terminal'),
    ).toThrow(/authority/);
  });
});
