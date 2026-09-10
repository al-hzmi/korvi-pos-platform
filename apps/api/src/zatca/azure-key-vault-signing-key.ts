import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  ZATCA_SIGNING_ALGORITHM,
  ZATCA_SIGNING_CURVE,
  ZatcaInvoiceError,
  xmlDsigEcdsaSignatureToDer,
  zatcaCsrSubject,
  type CreateZatcaCsrInput,
  type GenerateZatcaSigningKeyInput,
  type TenantScope,
  type ZatcaCsrSubject,
  type ZatcaSignInput,
  type ZatcaSigningKeyDescription,
  type ZatcaSigningKeyHandle,
  type ZatcaSigningKeyPort,
} from '@korvi/domain';

const AZURE_KEY_VAULT_API_VERSION = '2025-07-01';
const AZURE_PROVIDER = 'azure-key-vault';
const KEY_NAME = /^[0-9A-Za-z-]{1,127}$/;
const KEY_SEGMENT = /^[0-9A-Za-z-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_BYTES = 32;
const SECP256K1_COMPONENT_BYTES = 32;
const SECP256K1_ORDER = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141',
);
const LOW_S_LIMIT = SECP256K1_ORDER / 2n;
const TOKEN_EXPIRY_SKEW_MS = 60_000;

const OID = {
  commonName: '2.5.4.3',
  countryName: '2.5.4.6',
  organizationName: '2.5.4.10',
  organizationalUnitName: '2.5.4.11',
  serialNumber: '2.5.4.5',
  title: '2.5.4.12',
  businessCategory: '2.5.4.15',
  registeredAddress: '2.5.4.26',
  userId: '0.9.2342.19200300.100.1.1',
  extensionRequest: '1.2.840.113549.1.9.14',
  subjectAltName: '2.5.29.17',
  certificateTemplateName: '1.3.6.1.4.1.311.20.2',
  ecPublicKey: '1.2.840.10045.2.1',
  secp256k1: '1.3.132.0.10',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
} as const;

export interface AzureAccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface AzureKeyVaultJsonWebKey {
  readonly kid?: string;
  readonly kty?: string;
  readonly key_ops?: readonly string[];
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly d?: string;
}

export interface AzureKeyVaultKeyAttributes {
  readonly enabled?: boolean;
  readonly created?: number;
  readonly exportable?: boolean;
}

export interface AzureKeyVaultKeyBundle {
  readonly key?: AzureKeyVaultJsonWebKey;
  readonly attributes?: AzureKeyVaultKeyAttributes;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface AzureKeyVaultClient {
  createSecp256k1Key(input: {
    readonly keyName: string;
    readonly tags: Readonly<Record<string, string>>;
  }): Promise<AzureKeyVaultKeyBundle>;
  getKey(keyId: string): Promise<AzureKeyVaultKeyBundle>;
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

export interface AzureClientSecretAccessTokenProviderOptions {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export class AzureClientSecretAccessTokenProvider implements AzureAccessTokenProvider {
  private readonly tenantId: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private cached: { token: string; expiresAt: number } | null = null;
  private inFlight: Promise<string> | null = null;

  public constructor(options: AzureClientSecretAccessTokenProviderOptions) {
    if (!UUID.test(options.tenantId) || !UUID.test(options.clientId)) {
      throw new ZatcaInvoiceError('Azure tenant and client identifiers must be UUIDs.');
    }
    if (options.clientSecret.trim() === '') {
      throw new ZatcaInvoiceError('Azure client secret is required.');
    }
    this.tenantId = options.tenantId;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  public async getAccessToken(): Promise<string> {
    const current = this.cached;
    if (current !== null && current.expiresAt - TOKEN_EXPIRY_SKEW_MS > this.now()) {
      return current.token;
    }
    if (this.inFlight !== null) return this.inFlight;
    const request = this.requestToken();
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) this.inFlight = null;
    }
  }

  private async requestToken(): Promise<string> {
    const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'client_credentials',
      scope: 'https://vault.azure.net/.default',
    });
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'error',
      });
    } catch {
      throw new ZatcaInvoiceError('Azure identity token request failed.');
    }
    if (!response.ok) {
      throw new ZatcaInvoiceError(
        `Azure identity token request failed with HTTP ${String(response.status)}.`,
      );
    }
    const payload = await safeJson(response, 'Azure identity token response');
    const token = readRequiredString(payload, 'access_token', 'Azure identity token response');
    const expiresIn = readPositiveInteger(payload, 'expires_in', 'Azure identity token response');
    this.cached = { token, expiresAt: this.now() + expiresIn * 1000 };
    return token;
  }
}

export interface AzureKeyVaultRestClientOptions {
  readonly vaultUrl: string;
  readonly accessTokenProvider: AzureAccessTokenProvider;
  readonly fetchImpl?: typeof fetch;
}

export class AzureKeyVaultRestClient implements AzureKeyVaultClient {
  private readonly vault: URL;
  private readonly accessTokenProvider: AzureAccessTokenProvider;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: AzureKeyVaultRestClientOptions) {
    this.vault = parseVaultUrl(options.vaultUrl);
    this.accessTokenProvider = options.accessTokenProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async createSecp256k1Key(input: {
    readonly keyName: string;
    readonly tags: Readonly<Record<string, string>>;
  }): Promise<AzureKeyVaultKeyBundle> {
    if (!KEY_NAME.test(input.keyName)) {
      throw new ZatcaInvoiceError('Azure Key Vault key name is invalid.');
    }
    const url = new URL(`/keys/${input.keyName}/create`, this.vault);
    url.searchParams.set('api-version', AZURE_KEY_VAULT_API_VERSION);
    return this.requestKeyBundle(url, {
      method: 'POST',
      body: JSON.stringify({
        kty: 'EC',
        crv: 'P-256K',
        key_ops: ['sign', 'verify'],
        attributes: { enabled: true, exportable: false },
        tags: input.tags,
      }),
    });
  }

  public async getKey(keyId: string): Promise<AzureKeyVaultKeyBundle> {
    const keyUrl = parseVersionedKeyId(keyId, this.vault);
    keyUrl.searchParams.set('api-version', AZURE_KEY_VAULT_API_VERSION);
    return this.requestKeyBundle(keyUrl, { method: 'GET' });
  }

  public async signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array> {
    if (digest.length !== SHA256_BYTES) {
      throw new ZatcaInvoiceError('Azure Key Vault ES256K requires a 32-byte SHA-256 digest.');
    }
    const keyUrl = parseVersionedKeyId(keyId, this.vault);
    const url = new URL(`${keyUrl.pathname}/sign`, this.vault);
    url.searchParams.set('api-version', AZURE_KEY_VAULT_API_VERSION);
    const payload = await this.requestJson(url, {
      method: 'POST',
      body: JSON.stringify({ alg: 'ES256K', value: base64Url(digest) }),
    });
    const resultKeyId = readRequiredString(payload, 'kid', 'Azure Key Vault sign response');
    if (resultKeyId !== keyId) {
      throw new ZatcaInvoiceError(
        'Azure Key Vault returned a signature from a different key version.',
      );
    }
    const encoded = readRequiredString(payload, 'value', 'Azure Key Vault sign response');
    return decodeBase64Url(encoded, 'Azure Key Vault signature');
  }

  private async requestKeyBundle(url: URL, init: RequestInit): Promise<AzureKeyVaultKeyBundle> {
    const value = await this.requestJson(url, init);
    return value as AzureKeyVaultKeyBundle;
  }

  private async requestJson(url: URL, init: RequestInit): Promise<Record<string, unknown>> {
    let token: string;
    try {
      token = await this.accessTokenProvider.getAccessToken();
    } catch (error) {
      if (error instanceof ZatcaInvoiceError) throw error;
      throw new ZatcaInvoiceError('Azure Key Vault authentication failed.');
    }
    if (token.trim() === '') {
      throw new ZatcaInvoiceError('Azure Key Vault access token is empty.');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        redirect: 'error',
      });
    } catch {
      throw new ZatcaInvoiceError('Azure Key Vault request failed.');
    }
    if (!response.ok) {
      throw new ZatcaInvoiceError(
        `Azure Key Vault request failed with HTTP ${String(response.status)}.`,
      );
    }
    return safeJson(response, 'Azure Key Vault response');
  }
}

export interface AzureKeyVaultSigningKeyPortOptions {
  readonly client: AzureKeyVaultClient;
  readonly providerName?: string;
}

export class AzureKeyVaultSigningKeyPort implements ZatcaSigningKeyPort {
  private readonly client: AzureKeyVaultClient;
  private readonly providerName: string;

  public constructor(options: AzureKeyVaultSigningKeyPortOptions) {
    this.client = options.client;
    this.providerName = options.providerName ?? AZURE_PROVIDER;
    if (this.providerName.trim() === '') {
      throw new ZatcaInvoiceError('Azure signing provider name is required.');
    }
  }

  public async generateNonExportableKey(
    input: GenerateZatcaSigningKeyInput,
  ): Promise<ZatcaSigningKeyDescription> {
    assertScopeAndTerminal(input.scope, input.terminalId);
    if (input.keyAlias.trim() === '') {
      throw new ZatcaInvoiceError('ZATCA signing key alias is required.');
    }
    const keyName = providerKeyName(input.scope, input.terminalId, input.keyAlias);
    const bundle = await this.client.createSecp256k1Key({
      keyName,
      tags: keyTags(input.scope, input.terminalId),
    });
    return this.descriptionFromBundle(bundle, input.scope, input.terminalId);
  }

  public async describePublicKey(
    scope: TenantScope,
    terminalId: string,
    key: ZatcaSigningKeyHandle,
  ): Promise<ZatcaSigningKeyDescription> {
    assertScopeAndTerminal(scope, terminalId);
    this.assertHandle(key);
    const bundle = await this.client.getKey(key.keyId);
    const description = this.descriptionFromBundle(bundle, scope, terminalId);
    if (description.handle.keyId !== key.keyId) {
      throw new ZatcaInvoiceError('Azure Key Vault resolved a different signing key version.');
    }
    return description;
  }

  public async createPkcs10Csr(input: CreateZatcaCsrInput): Promise<Uint8Array> {
    const description = await this.describePublicKey(input.scope, input.terminalId, input.key);
    const subject = zatcaCsrSubject(input.subject);
    const requestInfo = certificationRequestInfo(
      subject,
      description.publicKeySpkiDer,
      certificateTemplateFor(input.environment),
    );
    const providerSignature = await this.client.signDigest(input.key.keyId, sha256(requestInfo));
    const signatureDer = canonicalLowSDer(providerSignature);
    assertSignature(description.publicKeySpkiDer, requestInfo, signatureDer, 'ZATCA CSR');
    return derSequence(
      requestInfo,
      derSequence(derOid(OID.ecdsaWithSha256)),
      derBitString(signatureDer),
    );
  }

  public async signSha256(input: ZatcaSignInput): Promise<Uint8Array> {
    if (input.message.length === 0) {
      throw new ZatcaInvoiceError('ZATCA signing message must not be empty.');
    }
    const description = await this.describePublicKey(input.scope, input.terminalId, input.key);
    const providerSignature = await this.client.signDigest(input.key.keyId, sha256(input.message));
    const signatureDer = canonicalLowSDer(providerSignature);
    assertSignature(description.publicKeySpkiDer, input.message, signatureDer, 'ZATCA stamp');
    return signatureDer;
  }

  private assertHandle(handle: ZatcaSigningKeyHandle): void {
    if (
      handle.provider !== this.providerName ||
      handle.curve !== ZATCA_SIGNING_CURVE ||
      handle.algorithm !== ZATCA_SIGNING_ALGORITHM ||
      handle.exportable !== false
    ) {
      throw new ZatcaInvoiceError(
        'ZATCA signing handle does not match the Azure secp256k1 authority.',
      );
    }
  }

  private descriptionFromBundle(
    bundle: AzureKeyVaultKeyBundle,
    scope: TenantScope,
    terminalId: string,
  ): ZatcaSigningKeyDescription {
    const key = bundle.key;
    const attributes = bundle.attributes;
    if (key === undefined || attributes === undefined) {
      throw new ZatcaInvoiceError('Azure Key Vault key response is incomplete.');
    }
    const keyId = requiredKeyId(key.kid);
    if (key.kty !== 'EC' && key.kty !== 'EC-HSM') {
      throw new ZatcaInvoiceError('Azure Key Vault ZATCA key must be an EC key.');
    }
    if (key.crv !== 'P-256K') {
      throw new ZatcaInvoiceError('Azure Key Vault ZATCA key must use P-256K/secp256k1.');
    }
    if (attributes.enabled !== true || attributes.exportable !== false) {
      throw new ZatcaInvoiceError(
        'Azure Key Vault ZATCA key must be enabled and explicitly non-exportable.',
      );
    }
    if (key.d !== undefined) {
      throw new ZatcaInvoiceError('Azure Key Vault unexpectedly returned private EC key material.');
    }
    const operations = new Set(key.key_ops ?? []);
    if (!operations.has('sign') || !operations.has('verify') || operations.has('export')) {
      throw new ZatcaInvoiceError(
        'Azure Key Vault ZATCA key operations are not restricted to signing authority.',
      );
    }
    assertTags(bundle.tags, scope, terminalId);
    const x = decodeBase64Url(
      requiredText(key.x, 'Azure EC x coordinate'),
      'Azure EC x coordinate',
    );
    const y = decodeBase64Url(
      requiredText(key.y, 'Azure EC y coordinate'),
      'Azure EC y coordinate',
    );
    if (x.length !== SECP256K1_COMPONENT_BYTES || y.length !== SECP256K1_COMPONENT_BYTES) {
      throw new ZatcaInvoiceError(
        'Azure Key Vault returned an invalid secp256k1 public key width.',
      );
    }
    const publicKeySpkiDer = secp256k1Spki(x, y);
    validatePublicKey(publicKeySpkiDer);
    const created = attributes.created;
    if (created === undefined || !Number.isSafeInteger(created) || created <= 0) {
      throw new ZatcaInvoiceError('Azure Key Vault key creation time is invalid.');
    }
    return {
      handle: {
        provider: this.providerName,
        keyId,
        curve: ZATCA_SIGNING_CURVE,
        algorithm: ZATCA_SIGNING_ALGORITHM,
        exportable: false,
      },
      publicKeySpkiDer,
      createdAt: new Date(created * 1000).toISOString(),
    };
  }
}

export function certificateTemplateFor(
  environment: CreateZatcaCsrInput['environment'],
): 'ZATCA-Code-Signing' | 'PREZATCA-Code-Signing' {
  return environment === 'simulation' ? 'PREZATCA-Code-Signing' : 'ZATCA-Code-Signing';
}

function certificationRequestInfo(
  subject: ZatcaCsrSubject,
  spkiDer: Uint8Array,
  certificateTemplate: string,
): Uint8Array {
  const distinguishedName = derName([
    [OID.countryName, derPrintableString(subject.countryCode)],
    [OID.organizationalUnitName, derUtf8String(subject.organizationalUnitName)],
    [OID.organizationName, derUtf8String(subject.organizationName)],
    [OID.commonName, derUtf8String(subject.commonName)],
  ]);
  const altName = derSequence(
    derContext(
      4,
      derName([
        [OID.serialNumber, derUtf8String(subject.egsSerialNumber)],
        [OID.userId, derUtf8String(subject.organizationIdentifier)],
        [OID.title, derUtf8String(subject.invoiceType)],
        [OID.registeredAddress, derUtf8String(subject.location)],
        [OID.businessCategory, derUtf8String(subject.industry)],
      ]),
    ),
  );
  const extensions = derSequence(
    derSequence(
      derOid(OID.certificateTemplateName),
      derOctetString(derPrintableString(certificateTemplate)),
    ),
    derSequence(derOid(OID.subjectAltName), derOctetString(altName)),
  );
  const extensionRequest = derSequence(derOid(OID.extensionRequest), derSet(extensions));
  return derSequence(
    derIntegerZero(),
    distinguishedName,
    Uint8Array.from(spkiDer),
    derTagged(0xa0, extensionRequest),
  );
}

function secp256k1Spki(x: Uint8Array, y: Uint8Array): Uint8Array {
  return derSequence(
    derSequence(derOid(OID.ecPublicKey), derOid(OID.secp256k1)),
    derBitString(Uint8Array.from([0x04, ...x, ...y])),
  );
}

function validatePublicKey(spkiDer: Uint8Array): void {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiDer), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp256k1') {
      throw new Error('wrong curve');
    }
  } catch {
    throw new ZatcaInvoiceError('Azure Key Vault returned an invalid secp256k1 public key.');
  }
}

function assertSignature(
  publicKeySpkiDer: Uint8Array,
  message: Uint8Array,
  signatureDer: Uint8Array,
  label: string,
): void {
  const key = createPublicKey({ key: Buffer.from(publicKeySpkiDer), format: 'der', type: 'spki' });
  const ok = verify('sha256', Buffer.from(message), key, Buffer.from(signatureDer));
  if (!ok) {
    throw new ZatcaInvoiceError(`${label} signature failed local public-key verification.`);
  }
}

function canonicalLowSDer(signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) {
    throw new ZatcaInvoiceError(
      'Azure Key Vault ES256K signature must be 64-byte IEEE-P1363 r||s.',
    );
  }
  const rBytes = signature.subarray(0, 32);
  const sBytes = signature.subarray(32);
  const r = scalar(rBytes, 'r');
  const s = scalar(sBytes, 's');
  const lowS = s > LOW_S_LIMIT ? SECP256K1_ORDER - s : s;
  return xmlDsigEcdsaSignatureToDer(Uint8Array.from([...bigInt32(r), ...bigInt32(lowS)]));
}

function scalar(bytes: Uint8Array, label: 'r' | 's'): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  if (value <= 0n || value >= SECP256K1_ORDER) {
    throw new ZatcaInvoiceError(
      `Azure Key Vault ECDSA ${label} scalar is outside secp256k1 order.`,
    );
  }
  return value;
}

function bigInt32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let current = value;
  for (let index = out.length - 1; index >= 0; index -= 1) {
    out[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  if (current !== 0n) {
    throw new ZatcaInvoiceError('ECDSA scalar exceeds secp256k1 width.');
  }
  return out;
}

function providerKeyName(scope: TenantScope, terminalId: string, alias: string): string {
  const digest = createHash('sha256')
    .update(scope.tenantId)
    .update('\0')
    .update(terminalId)
    .update('\0')
    .update(alias)
    .digest('hex');
  return `korvi-zatca-${digest}`;
}

function keyTags(scope: TenantScope, terminalId: string): Readonly<Record<string, string>> {
  return {
    'korvi-purpose': 'zatca-signing',
    'korvi-tenant': scope.tenantId,
    'korvi-terminal': terminalId,
  };
}

function assertTags(
  tags: Readonly<Record<string, string>> | undefined,
  scope: TenantScope,
  terminalId: string,
): void {
  if (
    tags?.['korvi-purpose'] !== 'zatca-signing' ||
    tags['korvi-tenant'] !== scope.tenantId ||
    tags['korvi-terminal'] !== terminalId
  ) {
    throw new ZatcaInvoiceError(
      'Azure Key Vault signing key belongs to a different Korvi authority.',
    );
  }
}

function assertScopeAndTerminal(scope: TenantScope, terminalId: string): void {
  if (scope.tenantId.trim() === '' || terminalId.trim() === '') {
    throw new ZatcaInvoiceError('ZATCA tenant and terminal identity are required.');
  }
}

function parseVaultUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ZatcaInvoiceError('Azure Key Vault URL is invalid.');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    (!host.endsWith('.vault.azure.net') && !host.endsWith('.managedhsm.azure.net'))
  ) {
    throw new ZatcaInvoiceError('Azure Key Vault URL must be a fixed Azure HTTPS vault origin.');
  }
  return url;
}

function parseVersionedKeyId(keyId: string, vault: URL): URL {
  let url: URL;
  try {
    url = new URL(keyId);
  } catch {
    throw new ZatcaInvoiceError('Azure Key Vault key handle is invalid.');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (
    url.protocol !== 'https:' ||
    url.origin !== vault.origin ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    parts.length !== 3 ||
    parts[0] !== 'keys' ||
    !KEY_SEGMENT.test(parts[1] ?? '') ||
    !KEY_SEGMENT.test(parts[2] ?? '')
  ) {
    throw new ZatcaInvoiceError(
      'Azure signing handle must identify one versioned key in the configured vault.',
    );
  }
  return url;
}

function requiredKeyId(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new ZatcaInvoiceError('Azure Key Vault response is missing the versioned key id.');
  }
  return value;
}

function requiredText(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === '') {
    throw new ZatcaInvoiceError(`${label} is missing.`);
  }
  return value;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function decodeBase64Url(value: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ZatcaInvoiceError(`${label} is not valid Base64URL.`);
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64url'));
  if (base64Url(bytes) !== value.replace(/=+$/u, '')) {
    throw new ZatcaInvoiceError(`${label} is not canonical Base64URL.`);
  }
  return bytes;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(bytes).digest());
}

async function safeJson(response: Response, label: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new ZatcaInvoiceError(`${label} is not valid JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ZatcaInvoiceError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.trim() === '') {
    throw new ZatcaInvoiceError(`${label} is missing ${key}.`);
  }
  return field;
}

function readPositiveInteger(value: Record<string, unknown>, key: string, label: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field <= 0) {
    throw new ZatcaInvoiceError(`${label} contains an invalid ${key}.`);
  }
  return field;
}

function derName(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  return derSequence(...entries.map(([oid, value]) => derSet(derSequence(derOid(oid), value))));
}

function derIntegerZero(): Uint8Array {
  return Uint8Array.from([0x02, 0x01, 0x00]);
}

function derUtf8String(value: string): Uint8Array {
  return derTagged(0x0c, Buffer.from(value, 'utf8'));
}

function derPrintableString(value: string): Uint8Array {
  if (!/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(value)) {
    throw new ZatcaInvoiceError(
      'ZATCA printable-string CSR value contains unsupported characters.',
    );
  }
  return derTagged(0x13, Buffer.from(value, 'ascii'));
}

function derOctetString(value: Uint8Array): Uint8Array {
  return derTagged(0x04, value);
}

function derBitString(value: Uint8Array): Uint8Array {
  return derTagged(0x03, Uint8Array.from([0, ...value]));
}

function derSet(...values: Uint8Array[]): Uint8Array {
  return derTagged(0x31, concat(values));
}

function derSequence(...values: Uint8Array[]): Uint8Array {
  return derTagged(0x30, concat(values));
}

function derContext(tagNumber: number, value: Uint8Array): Uint8Array {
  if (!Number.isInteger(tagNumber) || tagNumber < 0 || tagNumber > 30) {
    throw new ZatcaInvoiceError('ASN.1 context tag is invalid.');
  }
  return derTagged(0xa0 | tagNumber, value);
}

function derOid(value: string): Uint8Array {
  const arcs = value.split('.').map((part) => Number(part));
  if (
    arcs.length < 2 ||
    arcs.some((arc) => !Number.isSafeInteger(arc) || arc < 0) ||
    (arcs[0] ?? 3) > 2 ||
    ((arcs[0] ?? 0) < 2 && (arcs[1] ?? 40) >= 40)
  ) {
    throw new ZatcaInvoiceError('ASN.1 object identifier is invalid.');
  }
  const first = (arcs[0] ?? 0) * 40 + (arcs[1] ?? 0);
  const encoded = [first, ...arcs.slice(2).flatMap(encodeOidArc)];
  return derTagged(0x06, Uint8Array.from(encoded));
}

function encodeOidArc(value: number): number[] {
  if (value === 0) return [0];
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0x7f);
    remaining = Math.floor(remaining / 128);
  }
  for (let index = 0; index < bytes.length - 1; index += 1) {
    bytes[index] = (bytes[index] ?? 0) | 0x80;
  }
  return bytes;
}

function derTagged(tag: number, value: Uint8Array): Uint8Array {
  return Uint8Array.from([tag, ...derLength(value.length), ...value]);
}

function derLength(length: number): number[] {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new ZatcaInvoiceError('ASN.1 length is invalid.');
  }
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return [0x80 | bytes.length, ...bytes];
}

function concat(values: readonly Uint8Array[]): Uint8Array {
  const length = values.reduce((sum, value) => sum + value.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    out.set(value, offset);
    offset += value.length;
  }
  return out;
}
