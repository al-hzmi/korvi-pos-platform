import { describe, expect, it } from 'vitest';
import { ZatcaInvoiceError, type ZatcaCertificatePathEntry } from '@korvi/domain';
import { verifyZatcaCertificatePath } from '../zatca/certificate-path-validator.js';

const LEAF_DER = Buffer.from(
  'MIIB3jCCAYSgAwIBAgIUTuCx/ib7wmZ0haQVB52pc8xrCIIwCgYIKoZIzj0EAwIwRDEgMB4GA1UEAwwXS29ydmkgVGVzdCBJbnRlcm1lZGlhdGUxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMB4XDTI2MDkwOTIzNDIyMloXDTI5MDYwNTIzNDIyMlowOzEXMBUGA1UEAwwOS29ydmkgVGVzdCBFR1MxEzARBgNVBAoMCktvcnZpIFRlc3QxCzAJBgNVBAYTAlNBMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAExtCZqdiCZU4A196YvvvzGJzrvV2PJ2AY9o08pZ9U1EeV25ETytPUidGTON+nwDdqYe+SSZrBGcXKfBuhLXV75KNgMF4wDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0OBBYEFOeAiOZIOml+yYwvdiVAs9AvCmVWMB8GA1UdIwQYMBaAFIhLbjfz+A+FvmWK+9XdmDDDo9acMAoGCCqGSM49BAMCA0gAMEUCIE/dVTQxbO29P920Wu43gGA3MxYiL7wATgr+QSd2+PtQAiEA+7IUo+nZmZr5lS4/BSyNyO+ekWI/H6ksVp0KgFBlHY4=',
  'base64',
);
const INTERMEDIATE_DER = Buffer.from(
  'MIIB5TCCAYugAwIBAgIUdYLZDiOjXGGAmtDPCqlg88jOKnowCgYIKoZIzj0EAwIwPDEYMBYGA1UEAwwPS29ydmkgVGVzdCBSb290MRMwEQYDVQQKDApLb3J2aSBUZXN0MQswCQYDVQQGEwJTQTAeFw0yNjA5MDkyMzQyMjJaFw0zMjAzMDEyMzQyMjJaMEQxIDAeBgNVBAMMF0tvcnZpIFRlc3QgSW50ZXJtZWRpYXRlMRMwEQYDVQQKDApLb3J2aSBUZXN0MQswCQYDVQQGEwJTQTBWMBAGByqGSM49AgEGBSuBBAAKA0IABFuJv5AW6kLFSKKh/6olTvdMm5/5i2n8C/wzeAhWiJjav666Brek7kidpcAI0IGBwhB1Vmyqqx7eT/3SJm1f53WjZjBkMBIGA1UdEwEB/wQIMAYBAf8CAQAwDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBSIS2438/gPhb5livvV3Zgww6PWnDAfBgNVHSMEGDAWgBSMG9k5BAlFejfa8kmr9kXitE76sDAKBggqhkjOPQQDAgNIADBFAiALbLb7Iel7XY/bEEK7d3vqaxSLqCPhEJ6BQhnZ9PqZGgIhAJowilKwbETdukDmgCWK1jmHuNhtJpe8u0wYaKLKMlNZ',
  'base64',
);
const ROOT_DER = Buffer.from(
  'MIIB2jCCAYCgAwIBAgIUZ08DJbrzr4JDFdcYMhQUeMj7DiAwCgYIKoZIzj0EAwIwPDEYMBYGA1UEAwwPS29ydmkgVGVzdCBSb290MRMwEQYDVQQKDApLb3J2aSBUZXN0MQswCQYDVQQGEwJTQTAeFw0yNjA5MDkyMzQyMjJaFw0zNjA5MDYyMzQyMjJaMDwxGDAWBgNVBAMMD0tvcnZpIFRlc3QgUm9vdDETMBEGA1UECgwKS29ydmkgVGVzdDELMAkGA1UEBhMCU0EwVjAQBgcqhkjOPQIBBgUrgQQACgNCAATv7Z3XcLGRa37gAIO9Fjl0vqk4tQvM6QAjkCMaIOQR06yDBUc6ony0Z9+lXGQ17o0V9wMjepLw3i3PKadOuFOdo2MwYTAdBgNVHQ4EFgQUjBvZOQQJRXo32vJJq/ZF4rRO+rAwHwYDVR0jBBgwFoAUjBvZOQQJRXo32vJJq/ZF4rRO+rAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSAAwRQIhAJXe+r7oXInGv0pa0HWPUiNNge4FMYClo92UyQ76T17BAiAJT7kW7bDkTo6NzyZGuWegP3mpNZqFxHpj/aGr58Tyew==',
  'base64',
);
const ROOT_SHA256 = '9f7f32ff248230ee369e59c8062dadeb38afdadbe91683e65363551933302eee';
const LEAF_ISSUER = 'CN=Korvi Test Intermediate, O=Korvi Test, C=SA';
const ROOT_ISSUER = 'CN=Korvi Test Root, O=Korvi Test, C=SA';

function path(): ZatcaCertificatePathEntry[] {
  return [
    {
      certificateDer: Uint8Array.from(LEAF_DER),
      issuerName: LEAF_ISSUER,
      serialNumber: '450312152406879335212031948402126825523050645634',
    },
    {
      certificateDer: Uint8Array.from(INTERMEDIATE_DER),
      issuerName: ROOT_ISSUER,
      serialNumber: '670869925239569732157368057148473565833061083770',
    },
    {
      certificateDer: Uint8Array.from(ROOT_DER),
      issuerName: ROOT_ISSUER,
      serialNumber: '589788082441346456674380209399185534342317936160',
    },
  ];
}

describe('ZATCA X.509 certificate path trust validation', () => {
  it('verifies the path and derives XAdES signing-certificate identity from DER', () => {
    const result = verifyZatcaCertificatePath({
      certificatePath: path(),
      trustedAnchorSha256Hex: [ROOT_SHA256],
      at: '2027-01-01T00:00:00Z',
    });

    expect(result.trustAnchorSha256Hex).toBe(ROOT_SHA256);
    expect(result.certificateSha256Hex).toHaveLength(3);
    expect(result.certificateSha256Hex.at(-1)).toBe(ROOT_SHA256);
    expect(result.signingCertificateIssuerName).toBe(LEAF_ISSUER);
    expect(result.signingCertificateSerialNumber).toBe(
      '450312152406879335212031948402126825523050645634',
    );
  });

  it('refuses an arbitrary self-signed tail that is not server-pinned', () => {
    expect(() =>
      verifyZatcaCertificatePath({
        certificatePath: path(),
        trustedAnchorSha256Hex: ['0'.repeat(64)],
        at: '2027-01-01T00:00:00Z',
      }),
    ).toThrow(/server-pinned trust anchor/);
  });

  it('refuses malformed trust configuration instead of normalizing it silently', () => {
    for (const fingerprint of [ROOT_SHA256.toUpperCase(), `00:${ROOT_SHA256.slice(2)}`, 'abc']) {
      expect(() =>
        verifyZatcaCertificatePath({
          certificatePath: path(),
          trustedAnchorSha256Hex: [fingerprint],
          at: '2027-01-01T00:00:00Z',
        }),
      ).toThrow(/lower-case 64-character hex/);
    }
  });

  it('refuses path reordering and duplicate-certificate loops', () => {
    const reordered = path();
    [reordered[1], reordered[2]] = [reordered[2]!, reordered[1]!];
    expect(() =>
      verifyZatcaCertificatePath({
        certificatePath: reordered,
        trustedAnchorSha256Hex: [ROOT_SHA256],
        at: '2027-01-01T00:00:00Z',
      }),
    ).toThrow(/not issued by the next path certificate|signature verification failed/);

    const duplicate = path();
    duplicate.splice(1, 0, { ...duplicate[0]!, certificateDer: Uint8Array.from(LEAF_DER) });
    expect(() =>
      verifyZatcaCertificatePath({
        certificatePath: duplicate,
        trustedAnchorSha256Hex: [ROOT_SHA256],
        at: '2027-01-01T00:00:00Z',
      }),
    ).toThrow(/duplicate certificate or loop/);
  });

  it('refuses certificate validity outside the exact signing instant', () => {
    expect(() =>
      verifyZatcaCertificatePath({
        certificatePath: path(),
        trustedAnchorSha256Hex: [ROOT_SHA256],
        at: '2035-01-01T00:00:00Z',
      }),
    ).toThrow(/outside its validity window/);
  });

  it('refuses persisted serial or issuer metadata that does not describe the exact DER certificate', () => {
    const forgedSerial = path();
    forgedSerial[0] = { ...forgedSerial[0]!, serialNumber: '1' };
    expect(() =>
      verifyZatcaCertificatePath({
        certificatePath: forgedSerial,
        trustedAnchorSha256Hex: [ROOT_SHA256],
        at: '2027-01-01T00:00:00Z',
      }),
    ).toThrow(/serial metadata diverges/);

    const forgedIssuer = path();
    forgedIssuer[0] = { ...forgedIssuer[0]!, issuerName: 'CN=Forged Issuer' };
    expect(() =>
      verifyZatcaCertificatePath({
        certificatePath: forgedIssuer,
        trustedAnchorSha256Hex: [ROOT_SHA256],
        at: '2027-01-01T00:00:00Z',
      }),
    ).toThrow(/issuer metadata diverges/);
  });

  it('uses domain-specific failure when path/time input is malformed', () => {
    expect(() =>
      verifyZatcaCertificatePath({
        certificatePath: path().slice(0, 1),
        trustedAnchorSha256Hex: [ROOT_SHA256],
        at: '2027-01-01T00:00:00Z',
      }),
    ).toThrow(ZatcaInvoiceError);
    expect(() =>
      verifyZatcaCertificatePath({
        certificatePath: path(),
        trustedAnchorSha256Hex: [ROOT_SHA256],
        at: '2027-01-01T03:00:00+03:00',
      }),
    ).toThrow(/exact UTC second/);
  });
});
