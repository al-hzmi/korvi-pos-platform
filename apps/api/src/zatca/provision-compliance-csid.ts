import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ZatcaCsidProvisioningError,
  assertAutomaticZatcaCsidIssuanceAllowed,
  assertZatcaProvisioningReplay,
  extractZatcaSigningCertificateMaterial,
  type TenantScope,
  type ZatcaComplianceCsidIssuerPort,
  type ZatcaCsidProvisioningAttempt,
  type ZatcaCsidProvisioningRepository,
  type ZatcaSigningKeyPort,
} from '@korvi/domain';

export interface ZatcaProvisioningClock {
  /** Exact UTC second. The domain validates the returned value before persistence. */
  now(): string;
}

export interface ZatcaComplianceCsidProvisionerDependencies {
  readonly repository: ZatcaCsidProvisioningRepository;
  readonly issuer: ZatcaComplianceCsidIssuerPort;
  readonly signingKey: ZatcaSigningKeyPort;
  readonly clock: ZatcaProvisioningClock;
}

export interface ProvisionZatcaComplianceCsidInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly operationId: string;
  readonly requestHash: string;
  /** Exact DER PKCS#10 CSR already bound to the prepared attempt. */
  readonly csrDer: Uint8Array;
  /** Transient one-time code. Never persisted or included in errors. */
  readonly otp: string;
}

export interface ZatcaComplianceCsidProvisioner {
  provision(input: ProvisionZatcaComplianceCsidInput): Promise<ZatcaCsidProvisioningAttempt>;
}

/**
 * Execute one already-prepared Compliance CSID attempt.
 *
 * The repository's `in-flight` CAS is deliberately committed before the issuer
 * is called. A crash after that point cannot cause this service to reissue on a
 * replay: in-flight/uncertain attempts are returned for reconciliation instead.
 */
export function createZatcaComplianceCsidProvisioner(
  dependencies: ZatcaComplianceCsidProvisionerDependencies,
): ZatcaComplianceCsidProvisioner {
  return {
    async provision(input) {
      const existing = await dependencies.repository.findByOperationId(
        input.scope,
        input.operationId,
      );
      if (existing === null) {
        throw new ZatcaCsidProvisioningError(
          'ZATCA CSID issuance requires a durable prepared provisioning attempt.',
        );
      }
      assertZatcaProvisioningReplay(existing, input.operationId, input.requestHash);
      assertAuthority(existing, input.scope, input.terminalId);

      if (existing.state !== 'prepared') {
        return cloneAttempt(existing);
      }
      assertAutomaticZatcaCsidIssuanceAllowed(existing);
      assertCsrHash(existing.csrSha256Hex, input.csrDer);

      const keyDescription = await dependencies.signingKey.describePublicKey(
        input.scope,
        input.terminalId,
        existing.key,
      );
      assertSameKeyHandle(existing.key, keyDescription.handle);

      const inFlight = await dependencies.repository.markRequestStarted(
        input.scope,
        existing.attemptId,
        dependencies.clock.now(),
      );

      let result;
      try {
        result = await dependencies.issuer.issue({
          scope: input.scope,
          terminalId: input.terminalId,
          operationId: input.operationId,
          environment: existing.environment,
          csrDer: Uint8Array.from(input.csrDer),
          expectedPublicKeySpkiDer: Uint8Array.from(keyDescription.publicKeySpkiDer),
          otp: input.otp,
        });
      } catch {
        return dependencies.repository.markUncertain(input.scope, inFlight.attemptId, {
          resolvedAt: dependencies.clock.now(),
          uncertaintyReason: 'transport',
        });
      }

      if (result.kind === 'uncertain') {
        return dependencies.repository.markUncertain(input.scope, inFlight.attemptId, {
          resolvedAt: dependencies.clock.now(),
          uncertaintyReason: result.reason,
        });
      }
      if (result.kind === 'rejected') {
        return dependencies.repository.markRejected(input.scope, inFlight.attemptId, {
          resolvedAt: dependencies.clock.now(),
          rejectionCode: result.rejectionCode,
        });
      }

      try {
        const certificate = extractZatcaSigningCertificateMaterial(result.certificateDer);
        assertSameBytes(
          certificate.signingPublicKeySpkiDer,
          keyDescription.publicKeySpkiDer,
          'ZATCA issued certificate does not match the prepared signing key.',
        );
      } catch {
        return dependencies.repository.markUncertain(input.scope, inFlight.attemptId, {
          resolvedAt: dependencies.clock.now(),
          uncertaintyReason: 'response-invalid',
        });
      }

      return dependencies.repository.markIssued(input.scope, inFlight.attemptId, {
        resolvedAt: dependencies.clock.now(),
        remoteRequestId: result.remoteRequestId,
        credentialId: result.credentialId,
        certificateDer: Uint8Array.from(result.certificateDer),
        fatooraSecret: { ...result.fatooraSecret },
      });
    },
  };
}

function assertAuthority(
  attempt: ZatcaCsidProvisioningAttempt,
  scope: TenantScope,
  terminalId: string,
): void {
  if (attempt.scope.tenantId !== scope.tenantId || attempt.terminalId !== terminalId) {
    throw new ZatcaCsidProvisioningError(
      'ZATCA CSID provisioning attempt authority does not match tenant and terminal.',
    );
  }
}

function assertCsrHash(expectedHex: string, csrDer: Uint8Array): void {
  if (csrDer.length === 0) {
    throw new ZatcaCsidProvisioningError('ZATCA CSR must not be empty.');
  }
  const actual = createHash('sha256').update(csrDer).digest('hex');
  if (actual !== expectedHex) {
    throw new ZatcaCsidProvisioningError(
      'ZATCA CSR bytes do not match the durable prepared provisioning attempt.',
    );
  }
}

function assertSameKeyHandle(
  expected: ZatcaCsidProvisioningAttempt['key'],
  actual: ZatcaCsidProvisioningAttempt['key'],
): void {
  if (
    expected.provider !== actual.provider ||
    expected.keyId !== actual.keyId ||
    expected.curve !== actual.curve ||
    expected.algorithm !== actual.algorithm ||
    actual.exportable !== false
  ) {
    throw new ZatcaCsidProvisioningError(
      'ZATCA signing provider resolved a different key than the prepared attempt.',
    );
  }
}

function assertSameBytes(left: Uint8Array, right: Uint8Array, message: string): void {
  if (left.length !== right.length || !timingSafeEqual(Buffer.from(left), Buffer.from(right))) {
    throw new ZatcaCsidProvisioningError(message);
  }
}

function cloneAttempt(attempt: ZatcaCsidProvisioningAttempt): ZatcaCsidProvisioningAttempt {
  if (attempt.state === 'issued') {
    return {
      ...attempt,
      scope: { tenantId: attempt.scope.tenantId },
      key: { ...attempt.key },
      certificateDer: Uint8Array.from(attempt.certificateDer),
      fatooraSecret: { ...attempt.fatooraSecret },
    };
  }
  return {
    ...attempt,
    scope: { tenantId: attempt.scope.tenantId },
    key: { ...attempt.key },
  };
}
