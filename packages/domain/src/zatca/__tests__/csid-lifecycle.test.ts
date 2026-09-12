import { describe, expect, it } from 'vitest';
import { tenantId } from '../../ports/persistence.js';
import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  type ZatcaSigningKeyDescription,
  type ZatcaSigningKeyHandle,
} from '../../ports/zatca.js';
import { bytesToBase64 } from '../base64.js';
import { ZatcaInvoiceError } from '../phase2.js';
import {
  validateZatcaCsidForStamping,
  type ZatcaCsidBinding,
  type ZatcaCertificateStatusEvidence,
} from '../csid-lifecycle.js';

const scope = { tenantId: tenantId('tenant-a') };
const otherScope = { tenantId: tenantId('tenant-b') };
const certificateDer = Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x01]);
const issuerDer = Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x02]);
const rootDer = Uint8Array.from([0x30, 0x03, 0x02, 0x01, 0x03]);
const publicKeySpkiDer = Uint8Array.from([0x30, 0x02, 0x01, 0x01]);

const key: ZatcaSigningKeyHandle = {
  provider: 'test-hsm',
  keyId: 'key-1',
  curve: ZATCA_SIGNING_CURVE,
  algorithm: ZATCA_SIGNING_ALGORITHM,
  exportable: false,
};

const keyDescription: ZatcaSigningKeyDescription = {
  handle: key,
  publicKeySpkiDer,
  createdAt: '2026-09-01T00:00:00Z',
};

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const ownedBytes = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest('SHA-256', ownedBytes);
  return bytesToBase64(new Uint8Array(digest));
}

async function goodEvidence(
  coveredCertificateDer: Uint8Array,
  overrides: Partial<ZatcaCertificateStatusEvidence> = {},
): Promise<ZatcaCertificateStatusEvidence> {
  return {
    certificateSha256: await sha256Base64(coveredCertificateDer),
    status: 'good',
    source: 'crl',
    checkedAt: '2026-09-09T00:00:00Z',
    validUntil: '2026-09-16T00:00:00Z',
    ...overrides,
  };
}

async function validBinding(overrides: Partial<ZatcaCsidBinding> = {}): Promise<ZatcaCsidBinding> {
  return {
    credentialId: 'csid-1',
    scope,
    terminalId: 'terminal-1',
    state: 'active',
    key,
    certificatePath: [
      {
        certificateDer,
        issuerName: 'CN=ZATCA Technical CA',
        serialNumber: '123456789',
      },
      {
        certificateDer: issuerDer,
        issuerName: 'CN=ZATCA Root CA',
        serialNumber: '987654321',
      },
    ],
    certificateStatus: [await goodEvidence(certificateDer)],
    signingPublicKeySpkiDer: publicKeySpkiDer,
    notBefore: '2026-01-01T00:00:00Z',
    notAfter: '2027-01-01T00:00:00Z',
    fatooraSecret: { provider: 'vault', secretId: 'fatoora-1' },
    ...overrides,
  };
}

async function validate(overrides: Partial<ZatcaCsidBinding> = {}) {
  return validateZatcaCsidForStamping({
    scope,
    terminalId: 'terminal-1',
    at: '2026-09-10T00:00:00Z',
    keyDescription,
    binding: await validBinding(overrides),
  });
}

describe('ZATCA CSID stamping lifecycle', () => {
  it('accepts a tenant/terminal-bound active CSID with fresh status evidence for every path certificate', async () => {
    const result = await validate();
    expect(result.credentialId).toBe('csid-1');
    expect(result.key).toEqual(key);
    expect(result.certificatePath).toHaveLength(2);
    expect(result.signingCertificate.serialNumber).toBe('123456789');
    expect(result.signingPublicKeySpkiDer).toEqual(publicKeySpkiDer);
    expect(result.fatooraSecret).toEqual({ provider: 'vault', secretId: 'fatoora-1' });
  });

  it('requires one fresh status record for every non-trust-anchor certificate', async () => {
    await expect(validate({ certificateStatus: [] })).rejects.toThrow(/exactly 1 non-anchor/);

    await expect(
      validate({
        certificatePath: [
          { certificateDer, issuerName: 'CN=Intermediate', serialNumber: '1' },
          { certificateDer: issuerDer, issuerName: 'CN=Root', serialNumber: '2' },
          { certificateDer: rootDer, issuerName: 'CN=Root', serialNumber: '3' },
        ],
        certificateStatus: [await goodEvidence(certificateDer)],
      }),
    ).rejects.toThrow(/exactly 2 non-anchor/);

    await expect(
      validate({
        certificatePath: [
          { certificateDer, issuerName: 'CN=Intermediate', serialNumber: '1' },
          { certificateDer: issuerDer, issuerName: 'CN=Root', serialNumber: '2' },
          { certificateDer: rootDer, issuerName: 'CN=Root', serialNumber: '3' },
        ],
        certificateStatus: [await goodEvidence(certificateDer), await goodEvidence(issuerDer)],
      }),
    ).resolves.toBeDefined();
  });

  it('returns defensive copies of certificate/public-key bytes', async () => {
    const binding = await validBinding();
    const result = await validateZatcaCsidForStamping({
      scope,
      terminalId: 'terminal-1',
      at: '2026-09-10T00:00:00Z',
      keyDescription,
      binding,
    });
    result.signingCertificate.certificateDer[0] = 0;
    result.signingPublicKeySpkiDer[0] = 0;
    expect(binding.certificatePath[0]?.certificateDer[0]).toBe(0x30);
    expect(binding.signingPublicKeySpkiDer[0]).toBe(0x30);
  });

  it('refuses cross-tenant and cross-terminal credential reuse', async () => {
    const binding = await validBinding();
    await expect(
      validateZatcaCsidForStamping({
        scope: otherScope,
        terminalId: 'terminal-1',
        at: '2026-09-10T00:00:00Z',
        keyDescription,
        binding,
      }),
    ).rejects.toThrow(/different tenant/);
    await expect(validate({ terminalId: 'terminal-2' })).rejects.toThrow(/different terminal/);
  });

  it('refuses superseded or explicitly revoked lifecycle state', async () => {
    await expect(validate({ state: 'superseded' })).rejects.toThrow(/superseded/);
    await expect(validate({ state: 'revoked' })).rejects.toThrow(/revoked/);
  });

  it('refuses certificates before notBefore and after notAfter', async () => {
    const binding = await validBinding();
    await expect(
      validateZatcaCsidForStamping({
        scope,
        terminalId: 'terminal-1',
        at: '2025-12-31T23:59:59Z',
        keyDescription,
        binding,
      }),
    ).rejects.toThrow(/validity window/);
    await expect(
      validateZatcaCsidForStamping({
        scope,
        terminalId: 'terminal-1',
        at: '2027-01-01T00:00:01Z',
        keyDescription,
        binding,
      }),
    ).rejects.toThrow(/validity window/);
  });

  it('rejects impossible or non-canonical UTC instants instead of normalizing them', async () => {
    const binding = await validBinding();
    await expect(
      validateZatcaCsidForStamping({
        scope,
        terminalId: 'terminal-1',
        at: '2026-02-30T00:00:00Z',
        keyDescription,
        binding,
      }),
    ).rejects.toThrow(/real UTC calendar instant/);
    await expect(
      validateZatcaCsidForStamping({
        scope,
        terminalId: 'terminal-1',
        at: '2026-09-10T03:00:00+03:00',
        keyDescription,
        binding,
      }),
    ).rejects.toThrow(/exact UTC ISO-8601 second/);
  });

  it('refuses a signing-provider handle that diverges from the CSID binding', async () => {
    const binding = await validBinding();
    await expect(
      validateZatcaCsidForStamping({
        scope,
        terminalId: 'terminal-1',
        at: '2026-09-10T00:00:00Z',
        binding,
        keyDescription: { ...keyDescription, handle: { ...key, keyId: 'key-2' } },
      }),
    ).rejects.toThrow(/different key/);
  });

  it('refuses a certificate whose stored public key differs from the resolved non-exportable key', async () => {
    const binding = await validBinding();
    await expect(
      validateZatcaCsidForStamping({
        scope,
        terminalId: 'terminal-1',
        at: '2026-09-10T00:00:00Z',
        binding,
        keyDescription: { ...keyDescription, publicKeySpkiDer: Uint8Array.from([0x30, 0x00]) },
      }),
    ).rejects.toThrow(/not bound to the resolved signing key/);
  });

  it('refuses missing/invalid certificate path metadata', async () => {
    await expect(validate({ certificatePath: [], certificateStatus: [] })).rejects.toThrow(
      /signing certificate and trust anchor/,
    );
    await expect(
      validate({
        certificatePath: [
          { certificateDer: Uint8Array.of(), issuerName: 'CN=CA', serialNumber: '1' },
          { certificateDer: issuerDer, issuerName: 'CN=Root', serialNumber: '2' },
        ],
      }),
    ).rejects.toThrow(/empty certificate/);
    await expect(
      validate({
        certificatePath: [
          { certificateDer, issuerName: 'CN=CA', serialNumber: '0' },
          { certificateDer: issuerDer, issuerName: 'CN=Root', serialNumber: '2' },
        ],
      }),
    ).rejects.toThrow(/positive decimal integer/);
  });

  it('refuses unknown or revoked status even while evidence is fresh', async () => {
    await expect(
      validate({ certificateStatus: [await goodEvidence(certificateDer, { status: 'unknown' })] }),
    ).rejects.toThrow(/status is unknown/);
    await expect(
      validate({ certificateStatus: [await goodEvidence(certificateDer, { status: 'revoked' })] }),
    ).rejects.toThrow(/status is revoked/);
  });

  it('refuses stale, future-dated and over-long CRL evidence', async () => {
    await expect(
      validate({
        certificateStatus: [
          await goodEvidence(certificateDer, {
            checkedAt: '2026-09-01T00:00:00Z',
            validUntil: '2026-09-08T00:00:00Z',
          }),
        ],
      }),
    ).rejects.toThrow(/not fresh/);
    await expect(
      validate({
        certificateStatus: [
          await goodEvidence(certificateDer, {
            checkedAt: '2026-09-11T00:00:00Z',
            validUntil: '2026-09-12T00:00:00Z',
          }),
        ],
      }),
    ).rejects.toThrow(/not fresh/);
    await expect(
      validate({
        certificateStatus: [
          await goodEvidence(certificateDer, {
            checkedAt: '2026-09-02T23:59:59Z',
            validUntil: '2026-09-10T00:00:00Z',
          }),
        ],
      }),
    ).rejects.toThrow(/seven days/);
  });

  it('allows OCSP evidence to use its provider-defined freshness interval', async () => {
    await expect(
      validate({
        certificateStatus: [
          await goodEvidence(certificateDer, {
            source: 'ocsp',
            checkedAt: '2026-09-01T00:00:00Z',
            validUntil: '2026-09-11T00:00:00Z',
          }),
        ],
      }),
    ).resolves.toBeDefined();
  });

  it('refuses status evidence whose fingerprint does not match its path certificate', async () => {
    await expect(
      validate({
        certificateStatus: [
          await goodEvidence(certificateDer, {
            certificateSha256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          }),
        ],
      }),
    ).rejects.toThrow(/different certificate/);
  });

  it('keeps the FATOORA secret opaque and refuses an incomplete handle', async () => {
    await expect(validate({ fatooraSecret: { provider: '', secretId: 'secret' } })).rejects.toThrow(
      /secret handle is incomplete/,
    );
    await expect(validate({ fatooraSecret: { provider: 'vault', secretId: '' } })).rejects.toThrow(
      /secret handle is incomplete/,
    );
  });

  it('uses the exact secp256k1/SHA-256 key profile', async () => {
    const binding = await validBinding();
    const wrong = {
      ...binding.key,
      algorithm: 'ECDSA_P256_SHA256',
    } as unknown as ZatcaSigningKeyHandle;
    await expect(validate({ key: wrong })).rejects.toThrow(/secp256k1\/SHA-256/);
  });

  it('uses domain-specific refusals for lifecycle failures', async () => {
    await expect(validate({ credentialId: ' ' })).rejects.toBeInstanceOf(ZatcaInvoiceError);
  });
});
