import { timingSafeEqual } from 'node:crypto';
import {
  ZatcaCsidProvisioningError,
  assertAutomaticZatcaCsidIssuanceAllowed,
  assertZatcaComplianceEvidenceAuthority,
  assertZatcaProvisioningReplay,
  extractZatcaSigningCertificateMaterial,
  type TenantScope,
  type ZatcaComplianceEvidenceRepository,
  type ZatcaCsidProvisioningAttempt,
  type ZatcaCsidProvisioningRepository,
  type ZatcaProductionCsidIssuerPort,
  type ZatcaSigningKeyHandle,
  type ZatcaSigningKeyPort,
} from '@korvi/domain';
import type { ZatcaProvisioningClock } from './provision-compliance-csid.js';

export interface ZatcaProductionCsidProvisionerDependencies {
  readonly repository: ZatcaCsidProvisioningRepository;
  readonly complianceEvidence: ZatcaComplianceEvidenceRepository;
  readonly issuer: ZatcaProductionCsidIssuerPort;
  readonly signingKey: ZatcaSigningKeyPort;
  readonly clock: ZatcaProvisioningClock;
}

export interface ProvisionZatcaProductionCsidInput {
  readonly scope: TenantScope;
  readonly terminalId: string;
  readonly operationId: string;
  readonly requestHash: string;
  /** Durable accepted compliance evidence. Never accept a request-controlled CSID secret. */
  readonly complianceEvidenceId: string;
}

export interface ZatcaProductionCsidProvisioner {
  provision(input: ProvisionZatcaProductionCsidInput): Promise<ZatcaCsidProvisioningAttempt>;
}

/**
 * Execute one already-prepared Production CSID attempt.
 *
 * The accepted Compliance-CSID identity and Fatoora secret are resolved from
 * durable server-side evidence. The request can name only the evidence id; it
 * cannot provide a credential, secret handle, key or environment. As with
 * Compliance provisioning, the in-flight CAS commits before the first outbound
 * byte so an ambiguous remote side effect is never retried automatically.
 */
export function createZatcaProductionCsidProvisioner(
  dependencies: ZatcaProductionCsidProvisionerDependencies,
): ZatcaProductionCsidProvisioner {
  return {
    async provision(input) {
      const existing = await dependencies.repository.findByOperationId(
        input.scope,
        input.operationId,
      );
      if (existing === null) {
        throw new ZatcaCsidProvisioningError(
          'ZATCA Production CSID issuance requires a durable prepared provisioning attempt.',
        );
      }
      assertZatcaProvisioningReplay(existing, input.operationId, input.requestHash);
      assertAuthority(existing, input.scope, input.terminalId);

      if (existing.state !== 'prepared') {
        return cloneAttempt(existing);
      }
      assertAutomaticZatcaCsidIssuanceAllowed(existing);

      const evidence = await dependencies.complianceEvidence.findById(
        input.scope,
        input.complianceEvidenceId,
      );
      if (evidence === null) {
        throw new ZatcaCsidProvisioningError(
          'ZATCA Production CSID issuance requires accepted compliance evidence.',
        );
      }
      assertZatcaComplianceEvidenceAuthority(evidence, input.scope, input.terminalId);
      if (evidence.environment !== existing.environment) {
        throw new ZatcaCsidProvisioningError(
          'ZATCA Production CSID environment diverges from accepted compliance evidence.',
        );
      }
      assertSameKeyHandle(existing.key, evidence.key, 'accepted compliance evidence');

      const keyDescription = await dependencies.signingKey.describePublicKey(
        input.scope,
        input.terminalId,
        existing.key,
      );
      assertSameKeyHandle(existing.key, keyDescription.handle, 'signing provider');

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
          complianceRequestId: evidence.complianceRequestId,
          currentComplianceSecret: { ...evidence.currentComplianceSecret },
          expectedPublicKeySpkiDer: Uint8Array.from(keyDescription.publicKeySpkiDer),
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
          'ZATCA Production CSID certificate does not match the prepared signing key.',
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
      'ZATCA Production CSID provisioning authority does not match tenant and terminal.',
    );
  }
}

function assertSameKeyHandle(
  expected: ZatcaSigningKeyHandle,
  actual: ZatcaSigningKeyHandle,
  source: string,
): void {
  if (
    expected.provider !== actual.provider ||
    expected.keyId !== actual.keyId ||
    expected.curve !== actual.curve ||
    expected.algorithm !== actual.algorithm ||
    actual.exportable !== false
  ) {
    throw new ZatcaCsidProvisioningError(
      `ZATCA ${source} resolved a different key than the prepared Production CSID attempt.`,
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
