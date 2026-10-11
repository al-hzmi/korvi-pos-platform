import { describe, expect, it } from 'vitest';
import { tenantId } from '../../ports/persistence.js';
import {
  assertAutomaticZatcaCsidIssuanceAllowed,
  assertZatcaProvisioningReplay,
  markZatcaCsidIssued,
  markZatcaCsidRejected,
  markZatcaCsidRequestStarted,
  markZatcaCsidUncertain,
  prepareZatcaCsidProvisioning,
  ZatcaCsidProvisioningError,
} from '../csid-provisioning.js';

const key = {
  provider: 'test-hsm',
  keyId: 'terminal-7',
  curve: 'secp256k1' as const,
  algorithm: 'ECDSA_SECP256K1_SHA256' as const,
  exportable: false as const,
};

function prepared() {
  return prepareZatcaCsidProvisioning({
    attemptId: 'attempt-1',
    scope: { tenantId: tenantId('tenant-1') },
    terminalId: 'terminal-1',
    operationId: 'operation-1',
    requestHash: '11'.repeat(32),
    environment: 'sandbox',
    key,
    csrSha256Hex: '22'.repeat(32),
    preparedAt: '2026-09-10T09:00:00Z',
  });
}

describe('ZATCA CSID provisioning state machine', () => {
  it('requires a durable in-flight state before remote issuance and forbids blind retry afterward', () => {
    const initial = prepared();
    assertAutomaticZatcaCsidIssuanceAllowed(initial);

    const inFlight = markZatcaCsidRequestStarted(initial, '2026-09-10T09:00:01Z');
    expect(inFlight.state).toBe('in-flight');
    expect(() => assertAutomaticZatcaCsidIssuanceAllowed(inFlight)).toThrow(
      /cannot be issued automatically/,
    );

    const uncertain = markZatcaCsidUncertain(inFlight, {
      resolvedAt: '2026-09-10T09:00:20Z',
      uncertaintyReason: 'transport',
    });
    expect(uncertain.state).toBe('uncertain');
    expect(() => assertAutomaticZatcaCsidIssuanceAllowed(uncertain)).toThrow(
      /cannot be issued automatically/,
    );
  });

  it('resolves an in-flight or reconciled uncertain attempt without ever carrying raw secret material', () => {
    const inFlight = markZatcaCsidRequestStarted(prepared(), '2026-09-10T09:00:01Z');
    const uncertain = markZatcaCsidUncertain(inFlight, {
      resolvedAt: '2026-09-10T09:00:02Z',
      uncertaintyReason: 'response-invalid',
    });
    const issued = markZatcaCsidIssued(uncertain, {
      resolvedAt: '2026-09-10T09:00:03Z',
      remoteRequestId: 'zatca-request-1',
      credentialId: 'csid-1',
      certificateDer: Uint8Array.from([0x30, 0x01, 0x01]),
      fatooraSecret: { provider: 'vault', secretId: 'zatca/csid-1' },
    });

    expect(issued.state).toBe('issued');
    expect(issued.certificateDer).toEqual(Uint8Array.from([0x30, 0x01, 0x01]));
    expect(issued.fatooraSecret).toEqual({ provider: 'vault', secretId: 'zatca/csid-1' });
    expect(Object.keys(issued)).not.toContain('secret');
    expect(JSON.stringify(issued)).not.toContain('raw-secret');
  });

  it('records authoritative rejection separately from transport uncertainty', () => {
    const inFlight = markZatcaCsidRequestStarted(prepared(), '2026-09-10T09:00:01Z');
    const rejected = markZatcaCsidRejected(inFlight, {
      resolvedAt: '2026-09-10T09:00:02Z',
      rejectionCode: 'CSR_INVALID',
    });

    expect(rejected.state).toBe('rejected');
    expect(rejected.rejectionCode).toBe('CSR_INVALID');
    expect(() => assertAutomaticZatcaCsidIssuanceAllowed(rejected)).toThrow(
      ZatcaCsidProvisioningError,
    );
  });

  it('rejects an idempotency-key replay whose canonical request identity changed', () => {
    const attempt = prepared();
    expect(() =>
      assertZatcaProvisioningReplay(attempt, attempt.operationId, '33'.repeat(32)),
    ).toThrow(/different request identity/);
    expect(() =>
      assertZatcaProvisioningReplay(attempt, 'different-operation', attempt.requestHash),
    ).toThrow(/different request identity/);
    expect(() =>
      assertZatcaProvisioningReplay(attempt, attempt.operationId, attempt.requestHash),
    ).not.toThrow();
  });

  it('fails closed on malformed hashes, times, keys and impossible causal ordering', () => {
    expect(() =>
      prepareZatcaCsidProvisioning({
        attemptId: 'attempt-1',
        scope: { tenantId: tenantId('tenant-1') },
        terminalId: 'terminal-1',
        operationId: 'operation-1',
        requestHash: 'ABC',
        environment: 'sandbox',
        key,
        csrSha256Hex: '22'.repeat(32),
        preparedAt: '2026-09-10T09:00:00Z',
      }),
    ).toThrow(/request hash/);

    expect(() =>
      prepareZatcaCsidProvisioning({
        attemptId: 'attempt-2',
        scope: { tenantId: tenantId('tenant-1') },
        terminalId: 'terminal-1',
        operationId: 'operation-2',
        requestHash: '11'.repeat(32),
        environment: 'sandbox',
        key: { ...key, exportable: true } as never,
        csrSha256Hex: '22'.repeat(32),
        preparedAt: '2026-09-10T09:00:00Z',
      }),
    ).toThrow(/non-exportable/);

    expect(() => markZatcaCsidRequestStarted(prepared(), '2026-09-10T08:59:59Z')).toThrow(
      /cannot precede/,
    );
    expect(() => markZatcaCsidRequestStarted(prepared(), '2026-02-30T00:00:00Z')).toThrow(
      /real UTC instant/,
    );
  });
});
