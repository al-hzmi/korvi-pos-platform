import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  extractZatcaSigningCertificateMaterial,
  markZatcaCsidIssued,
  markZatcaCsidRejected,
  markZatcaCsidRequestStarted,
  markZatcaCsidUncertain,
  prepareZatcaCsidProvisioning,
  tenantId,
  type RecordZatcaAcceptedComplianceEvidenceInput,
  type TenantScope,
  type ZatcaAcceptedComplianceEvidence,
  type ZatcaComplianceEvidenceRepository,
  type ZatcaCsidProvisioningAttempt,
  type ZatcaCsidProvisioningRepository,
  type ZatcaInFlightCsidProvisioning,
  type ZatcaIssuedCsidProvisioning,
  type ZatcaProductionCsidIssuerPort,
  type ZatcaRejectedCsidProvisioning,
  type ZatcaSigningKeyPort,
  type ZatcaUncertainCsidProvisioning,
} from '@korvi/domain';
import { createZatcaProductionCsidProvisioner } from '../zatca/provision-production-csid.js';

const LEAF_DER = Buffer.from(
  'MIIB3jCCAYSgAwIBAgIUTuCx/ib7wmZ0haQVB52pc8xrCIIwCgYIKoZIzj0EAwIwRDEgMB4GA1UEAwwXS29ydmkgVGVzdCBJbnRlcm1lZGlhdGUxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMB4XDTI2MDkwOTIzNDIyMloXDTI5MDYwNTIzNDIyMlowOzEXMBUGA1UEAwwOS29ydmkgVGVzdCBFR1MxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAExtCZqdiCZU4A196YvvvzGJzrvV2PJ2AY9o08pZ9U1EeV25ETytPUidGTON+nwDdqYe+SSZrBGcXKfBuhLXV75KNgMF4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0OBBYEFOeAiOZIOml+yYwvdiVAs9AvCmVWMB8GA1UdIwQYMBaAFIhLbjfz+A+FvmWK+9XdmDDDo9acMAoGCCqGSM49BAMCA0gAMEUCIE/dVTQxbO29P920Wu43gGA3MxYiL7wATgr+QSd2+PtQAiEA+7IUo+nZmZr5lS4/BSyNyO+ekWI/H6ksVp0KgFBlHY4=',
  'base64',
);

const scope: TenantScope = { tenantId: tenantId('tenant-1') };
const terminalId = 'terminal-1';
const operationId = 'production-operation-1';
const requestHash = '44'.repeat(32);
const csrSha256Hex = createHash('sha256').update('production-csr').digest('hex');
const key = {
  provider: 'test-hsm',
  keyId: 'key-1',
  curve: 'secp256k1' as const,
  algorithm: 'ECDSA_SECP256K1_SHA256' as const,
  exportable: false as const,
};
const publicKeySpkiDer = extractZatcaSigningCertificateMaterial(LEAF_DER).signingPublicKeySpkiDer;

class MemoryProvisioningRepository implements ZatcaCsidProvisioningRepository {
  public attempt: ZatcaCsidProvisioningAttempt = prepareZatcaCsidProvisioning({
    attemptId: 'production-attempt-1',
    scope,
    terminalId,
    operationId,
    requestHash,
    environment: 'sandbox',
    key,
    csrSha256Hex,
    preparedAt: '2026-09-10T10:00:00Z',
  });

  public async findByOperationId(): Promise<ZatcaCsidProvisioningAttempt | null> {
    return this.attempt;
  }
  public async reservePrepared(): Promise<ZatcaCsidProvisioningAttempt> {
    return this.attempt;
  }
  public async markRequestStarted(
    _scope: TenantScope,
    _attemptId: string,
    requestStartedAt: string,
  ): Promise<ZatcaInFlightCsidProvisioning> {
    if (this.attempt.state !== 'prepared') throw new Error('CAS failed');
    this.attempt = markZatcaCsidRequestStarted(this.attempt, requestStartedAt);
    return this.attempt;
  }
  public async markIssued(
    _scope: TenantScope,
    _attemptId: string,
    result: Parameters<typeof markZatcaCsidIssued>[1],
  ): Promise<ZatcaIssuedCsidProvisioning> {
    if (this.attempt.state !== 'in-flight' && this.attempt.state !== 'uncertain') {
      throw new Error('CAS failed');
    }
    this.attempt = markZatcaCsidIssued(this.attempt, result);
    return this.attempt;
  }
  public async markRejected(
    _scope: TenantScope,
    _attemptId: string,
    result: Parameters<typeof markZatcaCsidRejected>[1],
  ): Promise<ZatcaRejectedCsidProvisioning> {
    if (this.attempt.state !== 'in-flight' && this.attempt.state !== 'uncertain') {
      throw new Error('CAS failed');
    }
    this.attempt = markZatcaCsidRejected(this.attempt, result);
    return this.attempt;
  }
  public async markUncertain(
    _scope: TenantScope,
    _attemptId: string,
    result: Parameters<typeof markZatcaCsidUncertain>[1],
  ): Promise<ZatcaUncertainCsidProvisioning> {
    if (this.attempt.state !== 'in-flight') throw new Error('CAS failed');
    this.attempt = markZatcaCsidUncertain(this.attempt, result);
    return this.attempt;
  }
}

const evidence: ZatcaAcceptedComplianceEvidence = {
  evidenceId: 'evidence-1',
  scope,
  terminalId,
  complianceAttemptId: 'compliance-attempt-1',
  environment: 'sandbox',
  complianceRequestId: 'compliance-request-1',
  currentComplianceCredentialId: `sha256:${'aa'.repeat(32)}`,
  currentComplianceSecret: { provider: 'vault', secretId: 'compliance-secret-1' },
  key,
  checkSetHash: 'bb'.repeat(32),
  acceptedAt: '2026-09-10T09:59:00Z',
};

function evidenceRepository(value: ZatcaAcceptedComplianceEvidence | null = evidence): ZatcaComplianceEvidenceRepository {
  return {
    async findById() {
      return value;
    },
    async recordAccepted(
      _scope: TenantScope,
      _input: RecordZatcaAcceptedComplianceEvidenceInput,
    ) {
      throw new Error('not used');
    },
  };
}

function signingKey(): ZatcaSigningKeyPort {
  return {
    async generateNonExportableKey() {
      throw new Error('not used');
    },
    async describePublicKey() {
      return {
        handle: key,
        publicKeySpkiDer: Uint8Array.from(publicKeySpkiDer),
        createdAt: '2026-09-10T09:00:00Z',
      };
    },
    async createPkcs10Csr() {
      throw new Error('not used');
    },
    async signSha256() {
      throw new Error('not used');
    },
  };
}

function clock() {
  const values = ['2026-09-10T10:00:01Z', '2026-09-10T10:00:02Z'];
  return { now: vi.fn(() => values.shift() ?? '2026-09-10T10:00:03Z') };
}

function input() {
  return { scope, terminalId, operationId, requestHash, complianceEvidenceId: evidence.evidenceId };
}

describe('ZATCA Production CSID provisioner', () => {
  it('uses only durable accepted compliance authority and commits in-flight before issuing', async () => {
    const repository = new MemoryProvisioningRepository();
    const issue = vi.fn<ZatcaProductionCsidIssuerPort['issue']>(async (request) => {
      expect(repository.attempt.state).toBe('in-flight');
      expect(request.environment).toBe(evidence.environment);
      expect(request.complianceRequestId).toBe(evidence.complianceRequestId);
      expect(request.currentComplianceSecret).toEqual(evidence.currentComplianceSecret);
      expect(request.expectedPublicKeySpkiDer).toEqual(publicKeySpkiDer);
      return {
        kind: 'issued',
        remoteRequestId: 'production-request-1',
        credentialId: `sha256:${'cc'.repeat(32)}`,
        certificateDer: Uint8Array.from(LEAF_DER),
        fatooraSecret: { provider: 'vault', secretId: 'production-secret-1' },
      };
    });
    const provisioner = createZatcaProductionCsidProvisioner({
      repository,
      complianceEvidence: evidenceRepository(),
      issuer: { issue },
      signingKey: signingKey(),
      clock: clock(),
    });

    const first = await provisioner.provision(input());
    expect(first.state).toBe('issued');
    expect(issue).toHaveBeenCalledTimes(1);

    const replay = await provisioner.provision(input());
    expect(replay.state).toBe('issued');
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('fails before network when compliance evidence is absent or has different authority', async () => {
    const cases: Array<ZatcaAcceptedComplianceEvidence | null> = [
      null,
      { ...evidence, terminalId: 'terminal-2' },
      { ...evidence, environment: 'production' },
      { ...evidence, key: { ...key, keyId: 'other-key' } },
    ];

    for (const candidate of cases) {
      const repository = new MemoryProvisioningRepository();
      const issue = vi.fn<ZatcaProductionCsidIssuerPort['issue']>();
      const provisioner = createZatcaProductionCsidProvisioner({
        repository,
        complianceEvidence: evidenceRepository(candidate),
        issuer: { issue },
        signingKey: signingKey(),
        clock: clock(),
      });
      await expect(provisioner.provision(input())).rejects.toThrow();
      expect(issue).not.toHaveBeenCalled();
      expect(repository.attempt.state).toBe('prepared');
    }
  });

  it('turns ambiguous transport into durable uncertainty and never retries automatically', async () => {
    const repository = new MemoryProvisioningRepository();
    const issue = vi.fn<ZatcaProductionCsidIssuerPort['issue']>(async () => {
      throw new Error('transport detail');
    });
    const provisioner = createZatcaProductionCsidProvisioner({
      repository,
      complianceEvidence: evidenceRepository(),
      issuer: { issue },
      signingKey: signingKey(),
      clock: clock(),
    });

    const first = await provisioner.provision(input());
    expect(first.state).toBe('uncertain');
    if (first.state === 'uncertain') expect(first.uncertaintyReason).toBe('transport');
    await provisioner.provision(input());
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
