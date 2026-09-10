import { execFileSync } from 'node:child_process';
import {
  createHash,
  generateKeyPairSync,
  verify,
  type KeyObject,
  type JsonWebKey,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  ecdsaDerToXmlDsigSignature,
  tenantId,
  type ZatcaCsrSubject,
  type ZatcaSigningKeyHandle,
} from '@korvi/domain';
import {
  AzureKeyVaultRestClient,
  AzureKeyVaultSigningKeyPort,
  certificateTemplateFor,
  type AzureKeyVaultClient,
  type AzureKeyVaultKeyBundle,
} from '../zatca/azure-key-vault-signing-key.js';

const SCOPE = { tenantId: tenantId('tenant-a') };
const TERMINAL_ID = '018f2e20-7b7a-7c00-8000-000000000012';
const KEY_ID =
  'https://korvi-test.vault.azure.net/keys/korvi-zatca-test/0123456789abcdef0123456789abcdef';
const SECP256K1_ORDER = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);
const LOW_S_LIMIT = SECP256K1_ORDER / 2n;

const SUBJECT: ZatcaCsrSubject = {
  commonName: 'KORVI-EGS-001',
  egsSerialNumber: '1-Korvi|2-POS-1|3-000001',
  organizationIdentifier: '310123456789013',
  organizationalUnitName: 'Riyadh Branch',
  organizationName: 'Korvi Test Merchant',
  countryCode: 'SA',
  invoiceType: '1100',
  location: 'Riyadh',
  industry: 'Retail',
};

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

function bundle(
  publicJwk: JsonWebKey,
  overrides: Partial<AzureKeyVaultKeyBundle> = {},
): AzureKeyVaultKeyBundle {
  const x = publicJwk.x;
  const y = publicJwk.y;
  if (x === undefined || y === undefined) {
    throw new Error('Generated secp256k1 test key is missing public coordinates.');
  }
  return {
    key: {
      kid: KEY_ID,
      kty: 'EC',
      key_ops: ['sign', 'verify'],
      crv: 'P-256K',
      x,
      y,
    },
    attributes: { enabled: true, exportable: false, created: 1_725_000_000 },
    tags: {
      'korvi-purpose': 'zatca-signing',
      'korvi-tenant': SCOPE.tenantId,
      'korvi-terminal': TERMINAL_ID,
    },
    ...overrides,
  };
}

function highSRawSignature(privateKey: KeyObject, digest: Uint8Array): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), 'korvi-azure-sign-'));
  try {
    const keyPath = join(directory, 'key.pem');
    const digestPath = join(directory, 'digest.bin');
    const signaturePath = join(directory, 'signature.der');
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(digestPath, digest, { mode: 0o600 });
    execFileSync(
      'openssl',
      [
        'pkeyutl',
        '-sign',
        '-inkey',
        keyPath,
        '-in',
        digestPath,
        '-pkeyopt',
        'digest:sha256',
        '-out',
        signaturePath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    const raw = ecdsaDerToXmlDsigSignature(Uint8Array.from(readFileSync(signaturePath)));
    const s = bytesToBigInt(raw.subarray(32));
    const highS = s > LOW_S_LIMIT ? s : SECP256K1_ORDER - s;
    return Uint8Array.from([...raw.subarray(0, 32), ...bigInt32(highS)]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bigInt32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let current = value;
  for (let index = out.length - 1; index >= 0; index -= 1) {
    out[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return out;
}

function fakeClient(keyBundle: AzureKeyVaultKeyBundle, privateKey: KeyObject): AzureKeyVaultClient {
  return {
    createSecp256k1Key: vi.fn(async () => keyBundle),
    getKey: vi.fn(async () => keyBundle),
    signDigest: vi.fn(async (_keyId, digest) => highSRawSignature(privateKey, digest)),
  };
}

function handle(): ZatcaSigningKeyHandle {
  return {
    provider: 'azure-key-vault',
    keyId: KEY_ID,
    curve: ZATCA_SIGNING_CURVE,
    algorithm: ZATCA_SIGNING_ALGORITHM,
    exportable: false,
  };
}

describe('Azure Key Vault ZATCA signing authority', () => {
  it('maps the immutable FATOORA environment to the required CSR certificate template', () => {
    expect(certificateTemplateFor('sandbox')).toBe('ZATCA-Code-Signing');
    expect(certificateTemplateFor('production')).toBe('ZATCA-Code-Signing');
    expect(certificateTemplateFor('simulation')).toBe('PREZATCA-Code-Signing');
  });

  it('creates a verifiable Simulation PKCS#10 CSR with the PREZATCA template', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const port = new AzureKeyVaultSigningKeyPort({
      client: fakeClient(bundle(publicJwk), privateKey),
    });

    const csrDer = await port.createPkcs10Csr({
      scope: SCOPE,
      terminalId: TERMINAL_ID,
      key: handle(),
      subject: SUBJECT,
      environment: 'simulation',
    });

    expect(Buffer.from(csrDer).includes(Buffer.from('PREZATCA-Code-Signing'))).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), 'korvi-zatca-csr-'));
    try {
      const csrPath = join(directory, 'request.der');
      writeFileSync(csrPath, csrDer, { mode: 0o600 });
      const text = execFileSync(
        'openssl',
        ['req', '-inform', 'DER', '-in', csrPath, '-verify', '-noout', '-text'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      );
      expect(text).toContain('310123456789013');
      expect(text).toContain('1-Korvi|2-POS-1|3-000001');
      expect(text).toContain('1100');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('hashes canonical SignedInfo once for Azure ES256K, normalizes high-S, and returns verified DER', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const client = fakeClient(bundle(publicJwk), privateKey);
    const port = new AzureKeyVaultSigningKeyPort({ client });
    const signedInfo = Buffer.from(
      '<ds:SignedInfo><ds:Reference URI=""><ds:DigestValue>invoice</ds:DigestValue></ds:Reference><ds:Reference URI="#xadesSignedProperties"><ds:DigestValue>properties</ds:DigestValue></ds:Reference></ds:SignedInfo>',
      'utf8',
    );

    const signatureDer = await port.signSha256({
      scope: SCOPE,
      terminalId: TERMINAL_ID,
      key: handle(),
      message: signedInfo,
    });

    expect(client.signDigest).toHaveBeenCalledWith(
      KEY_ID,
      Uint8Array.from(createHash('sha256').update(signedInfo).digest()),
    );
    expect(verify('sha256', signedInfo, publicKey, signatureDer)).toBe(true);
    const raw = ecdsaDerToXmlDsigSignature(signatureDer);
    expect(bytesToBigInt(raw.subarray(32))).toBeLessThanOrEqual(LOW_S_LIMIT);
  });

  it('fails closed if Azure marks the key exportable', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const port = new AzureKeyVaultSigningKeyPort({
      client: fakeClient(
        bundle(publicJwk, {
          attributes: { enabled: true, exportable: true, created: 1_725_000_000 },
        }),
        privateKey,
      ),
    });

    await expect(port.describePublicKey(SCOPE, TERMINAL_ID, handle())).rejects.toThrow(
      /non-exportable/i,
    );
  });

  it('fails closed on wrong curve, export permission, private material, or tenant tags', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const invalidBundles: AzureKeyVaultKeyBundle[] = [
      bundle(publicJwk, { key: { ...bundle(publicJwk).key, crv: 'P-256' } }),
      bundle(publicJwk, {
        key: { ...bundle(publicJwk).key, key_ops: ['sign', 'verify', 'export'] },
      }),
      bundle(publicJwk, { key: { ...bundle(publicJwk).key, d: base64Url('forbidden') } }),
      bundle(publicJwk, {
        tags: {
          'korvi-purpose': 'zatca-signing',
          'korvi-tenant': 'tenant-b',
          'korvi-terminal': TERMINAL_ID,
        },
      }),
    ];

    for (const keyBundle of invalidBundles) {
      const port = new AzureKeyVaultSigningKeyPort({ client: fakeClient(keyBundle, privateKey) });
      await expect(port.describePublicKey(SCOPE, TERMINAL_ID, handle())).rejects.toThrow();
    }
  });

  it('rejects an unversioned or foreign-vault handle before network access', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const rest = new AzureKeyVaultRestClient({
      vaultUrl: 'https://korvi-test.vault.azure.net',
      accessTokenProvider: { getAccessToken: async () => 'token' },
      fetchImpl,
    });

    await expect(
      rest.getKey('https://korvi-test.vault.azure.net/keys/key-without-version'),
    ).rejects.toThrow(/versioned key/i);
    await expect(rest.getKey('https://attacker.example/keys/key/version')).rejects.toThrow(
      /configured vault/i,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('creates only EC P-256K sign/verify non-exportable keys over the fixed Azure origin', async () => {
    const responseBody = {
      key: {
        kid: KEY_ID,
        kty: 'EC',
        key_ops: ['sign', 'verify'],
        crv: 'P-256K',
        x: base64Url(Buffer.alloc(32, 1)),
        y: base64Url(Buffer.alloc(32, 2)),
      },
      attributes: { enabled: true, exportable: false, created: 1_725_000_000 },
      tags: {},
    };
    const fetchImpl = vi.fn<typeof fetch>(
      async (_input, _init) =>
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const rest = new AzureKeyVaultRestClient({
      vaultUrl: 'https://korvi-test.vault.azure.net',
      accessTokenProvider: { getAccessToken: async () => 'token' },
      fetchImpl,
    });

    await rest.createSecp256k1Key({ keyName: 'korvi-zatca-test', tags: {} });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://korvi-test.vault.azure.net/keys/korvi-zatca-test/create?api-version=2025-07-01',
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      kty: 'EC',
      crv: 'P-256K',
      key_ops: ['sign', 'verify'],
      attributes: { enabled: true, exportable: false },
      tags: {},
    });
  });
});
