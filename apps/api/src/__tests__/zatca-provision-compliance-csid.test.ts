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
  type TenantScope,
  type ZatcaComplianceCsidIssuerPort,
  type ZatcaCsidProvisioningAttempt,
  type ZatcaCsidProvisioningRepository,
  type ZatcaInFlightCsidProvisioning,
  type ZatcaIssuedCsidProvisioning,
  type ZatcaRejectedCsidProvisioning,
  type ZatcaSigningKeyPort,
  type ZatcaUncertainCsidProvisioning,
} from '@korvi/domain';
import { createZatcaComplianceCsidProvisioner } from '../zatca/provision-compliance-csid.js';

const LEAF_DER = Buffer.from(
  'MIIB3jCCAYSgAwIBAgIUTuCx/ib7wmZ0haQVB52pc8xrCIIwCgYIKoZIzj0EAwIwRDEgMB4GA1UEAwwXS29ydmkgVGVzdCBJbnRlcm1lZGlhdGUxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMB4XDTI2MDkwOTIzNDIyMloXDTI5MDYwNTIzNDIyMlowOzEXMBUGA1UEAwwOS29ydmkgVGVzdCBFR1MxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAExtCZqdiCZU4A196YvvvzGJzrvV2PJ2AY9o08pZ9U1EeV25ETytPUidGTON+nwDdqYe+SSZrBGcXKfBuhLXV75KNgMF4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0OBBYEFOeAiOZIOml+yYwvdiVAs9AvCmVWMB8GA1UdIwQYMBaAFIhLbjfz+A+FvmWK+9XdmDDDo9acMAoGCCqGSM49BAMCA0gAMEUCIE/dVTQxbO29P920Wu43gGA3MxYiL7wATgr+QSd2+PtQAiEA+7IUo+nZmZr5lS4/BSyNyO+ekWI/H6ksVp0KgFBlHY4=',
  'base64',
);
const OTHER_LEAF_DER = Buffer.from(
  'MIIB2jCCAYCgAwIBAgIUZ08DJbrzr4JDFdcYMhQUeMj7DiAwCgYIKoZIzj0EAwIwPDEYMBYGA1UEAwwPS29ydmkgVGVzdCBSb290MRMwEQYDVQQKDApLb3J2aSBUZXN0MQswCQYDVQQGEwJTQTAeFw0yNjA5MDkyMzQyMjJaFw0zNjA5MDYyMzQyMjJaMDwxGDAWBgNVBAMMD0tvcnZpIFRlc3QgUm9vdDETMBEGA1UECgwKS29ydmkgVGVzdDELMAkGA1UEBhMCU0EwVjAQBgcqhkjOPQIBBgUrgQQACgNCAATv7Z3XcLGRa37gAIO9Fjl0vqk4tQvM6QAjkCMaIOQR06yDBUc6ony0Z9+lXGQ17o0V9wMjepLw3i3PKadOuFOdo2MwYTAdBgNVHQ4EFgQUjBvZOQQJRXo32vJJq/ZF4rRO+rAwHwYDVR0jBBgwFoAUjBvZOQQJRXo32vJJq/ZF4rRO+rAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSAAwRQIhAJXe+r7oXInGv0pa0HWPUiNNge4FMYClo92UyQ76T17BAiAJT7kW7bDkTo6NzyZGuWegP3mpNZqFxHpj/aGr58Tyew==',
  'base64',
);
const scope: TenantScope = { tenantId: tenantId('tenant-1') };
const terminalId = 'terminal-1';
const operationId = 'operation-1';
const csrDer = Uint8Array.from([0x30, 0x03, 0x01, 0x02, 0x03]);
const requestHash = '11'.repeat(32);
const csrSha256Hex = createHash('sha256').update(csrDer).digest('hex');
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
    attemptId: 'attempt-1',
    scope,
    terminalId,
    operationId,
    requestHash,
    environment: 'sandbox',
    key,
    csrSha256Hex,
    preparedAt: '2026-09-10T09:00:00Z',
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

function signingKey(): ZatcaSigningKeyPort {
  return {
    async generateNonExportableKey() {
      throw new Error('not used');
    },
    async describePublicKey() {
      return {
        handle: key,
        publicKeySpkiDer: Uint8Array.from(publicKeySpkiDer),
        createdAt: '2026-09-10T08:59:00Z',
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
  const values = ['2026-09-10T09:00:01Z', '2026-09-10T09:00:02Z'];
  return { now: vi.fn(() => values.shift() ?? '2026-09-10T09:00:03Z') };
}

function input() {
  return { scope, terminalId, operationId, requestHash, csrDer, otp: 'otp-never-log' };
}

describe('ZATCA Compliance CSID provisioner', () => {
  it('commits in-flight before calling the issuer and durably resolves an issued credential', async () => {
    const repository = new MemoryProvisioningRepository();
    const issue = vi.fn<ZatcaComplianceCsidIssuerPort['issue']>(async (request) => {
      expect(repository.attempt.state).toBe('in-flight');
      expect(request.expectedPublicKeySpkiDer).toEqual(publicKeySpkiDer);
      return {
        kind: 'issued',
        remoteRequestId: 'remote-1',
        credentialId: 'credential-1',
        certificateDer: Uint8Array.from(LEAF_DER),
        fatooraSecret: { provider: 'vault', secretId: 'zatca/credential-1' },
      };
    });
    const provisioner = createZatcaComplianceCsidProvisioner({
      repository,
      issuer: { issue },
      signingKey: signingKey(),
      clock: clock(),
    });

    const result = await provisioner.provision(input());
    expect(result.state).toBe('issued');
    expect(issue).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('otp-never-log');

    const replay = await provisioner.provision(input());
    expect(replay.state).toBe('issued');
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('turns a thrown network call into uncertain and refuses automatic retry', async () => {
    const repository = new MemoryProvisioningRepository();
    const issue = vi.fn<ZatcaComplianceCsidIssuerPort['issue']>(async () => {
      throw new Error('socket detail must not escape');
    });
    const provisioner = createZatcaComplianceCsidProvisioner({
      repository,
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

  it('fails closed when the issued certificate does not carry the prepared HSM key', async () => {
    const repository = new MemoryProvisioningRepository();
    const issue = vi.fn<ZatcaComplianceCsidIssuerPort['issue']>(async () => ({
      kind: 'issued',
      remoteRequestId: 'remote-1',
      credentialId: 'credential-wrong-key',
      certificateDer: Uint8Array.from(OTHER_LEAF_DER),
      fatooraSecret: { provider: 'vault', secretId: 'zatca/wrong-key' },
    }));
    const provisioner = createZatcaComplianceCsidProvisioner({
      repository,
      issuer: { issue },
      signingKey: signingKey(),
      clock: clock(),
    });

    const result = await provisioner.provision(input());
    expect(result.state).toBe('uncertain');
    if (result.state === 'uncertain') expect(result.uncertaintyReason).toBe('response-invalid');
  });

  it('does not cross the network boundary for changed CSR, idempotency conflict, tenant or terminal', async () => {
    const cases = [
      { ...input(), csrDer: Uint8Array.from([0x30, 0x00]) },
      { ...input(), requestHash: '33'.repeat(32) },
      { ...input(), scope: { tenantId: tenantId('tenant-2') } },
      { ...input(), terminalId: 'terminal-2' },
    ];

    for (const candidate of cases) {
      const repository = new MemoryProvisioningRepository();
      const issue = vi.fn<ZatcaComplianceCsidIssuerPort['issue']>();
      const provisioner = createZatcaComplianceCsidProvisioner({
        repository,
        issuer: { issue },
        signingKey: signingKey(),
        clock: clock(),
      });
      await expect(provisioner.provision(candidate)).rejects.toThrow();
      expect(issue).not.toHaveBeenCalled();
      expect(repository.attempt.state).toBe('prepared');
    }
  });
});
