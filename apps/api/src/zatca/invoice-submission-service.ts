import {
  ZatcaInvoiceSubmissionError,
  assertAutomaticZatcaInvoiceSubmissionAllowed,
  assertZatcaInvoiceSubmissionReplay,
  bytesToBase64,
  prepareZatcaInvoiceSubmission,
  systemClock,
  uuidV7,
  type Clock,
  type IdGenerator,
  type TenantScope,
  type ZatcaDurableInvoiceSubmission,
  type ZatcaFatooraSecretHandle,
  type ZatcaInvoiceSubmissionMode,
  type ZatcaInvoiceSubmissionPort,
  type ZatcaInvoiceSubmissionRepository,
  type ZatcaRejectedDurableInvoiceSubmission,
  type ZatcaAcceptedDurableInvoiceSubmission,
} from '@korvi/domain';
import type { ZatcaCsidEnvironment } from '@korvi/domain';

const MAX_CLEARED_INVOICE_BASE64_CHARACTERS = 4 * 1024 * 1024;

export interface SubmitDurableZatcaInvoiceInput {
  readonly scope: TenantScope;
  readonly invoiceId: string;
  readonly terminalId: string;
  readonly environment: ZatcaCsidEnvironment;
  readonly mode: ZatcaInvoiceSubmissionMode;
  readonly invoiceUuid: string;
  readonly invoiceHash: Uint8Array;
  readonly sealedInvoiceXml: Uint8Array;
  readonly productionSecret: ZatcaFatooraSecretHandle;
}

export type ReconcileZatcaInvoiceOutcome =
  | {
      readonly kind: 'accepted';
      readonly httpStatus: number;
      readonly authorityStatus: 'REPORTED' | 'CLEARED';
      readonly clearedInvoiceXml?: Uint8Array;
    }
  | {
      readonly kind: 'rejected';
      readonly httpStatus: number;
      readonly rejectionCode: string;
    };

export interface ReconcileZatcaInvoiceInput {
  readonly scope: TenantScope;
  readonly invoiceId: string;
  readonly mode: ZatcaInvoiceSubmissionMode;
  readonly outcome: ReconcileZatcaInvoiceOutcome;
}

export interface ZatcaInvoiceSubmissionService {
  /**
   * Claims and performs at most one automatic FATOORA attempt. A previously
   * in-flight, uncertain or resolved row is returned without touching the
   * network. This is the only automatic-send authority for Gate 40.
   */
  submit(input: SubmitDurableZatcaInvoiceInput): Promise<ZatcaDurableInvoiceSubmission>;

  /**
   * Records a trusted out-of-band reconciliation decision. It never performs
   * an HTTP request and only resolves an already-uncertain submission.
   */
  reconcileUncertain(
    input: ReconcileZatcaInvoiceInput,
  ): Promise<ZatcaAcceptedDurableInvoiceSubmission | ZatcaRejectedDurableInvoiceSubmission>;
}

export interface CreateZatcaInvoiceSubmissionServiceOptions {
  readonly repository: ZatcaInvoiceSubmissionRepository;
  readonly transport: ZatcaInvoiceSubmissionPort;
  readonly idGenerator?: IdGenerator;
  readonly clock?: Clock;
}

/**
 * Durable Gate-40 reporting / clearance coordinator.
 *
 * Ordering is the safety property:
 *   1. freeze exact UUID/hash/XML/credential handle in PostgreSQL;
 *   2. atomically transition pending -> in-flight;
 *   3. only then allow one transport call;
 *   4. persist the definite/ambiguous outcome.
 *
 * If the process dies after (2), the durable in-flight row deliberately blocks
 * an automatic resend. If the authority may have accepted a request whose
 * response was lost, reconciliation is safer than creating a duplicate remote
 * side effect.
 */
export function createZatcaInvoiceSubmissionService(
  options: CreateZatcaInvoiceSubmissionServiceOptions,
): ZatcaInvoiceSubmissionService {
  const idGenerator = options.idGenerator ?? uuidV7;
  const clock = options.clock ?? systemClock;

  return {
    async submit(input) {
      const candidate = prepareZatcaInvoiceSubmission({
        submissionId: idGenerator.next(),
        scope: input.scope,
        invoiceId: input.invoiceId,
        terminalId: input.terminalId,
        environment: input.environment,
        mode: input.mode,
        invoiceUuid: input.invoiceUuid,
        invoiceHash: input.invoiceHash,
        sealedInvoiceXml: input.sealedInvoiceXml,
        productionSecret: input.productionSecret,
        queuedAt: utcSecond(clock),
      });

      const reserved = await options.repository.reservePending(input.scope, candidate);
      assertZatcaInvoiceSubmissionReplay(reserved, candidate);
      if (reserved.state !== 'pending') return reserved;
      assertAutomaticZatcaInvoiceSubmissionAllowed(reserved);

      let inFlight;
      try {
        inFlight = await options.repository.markRequestStarted(
          input.scope,
          reserved.submissionId,
          utcSecondAtOrAfter(clock, reserved.queuedAt),
        );
      } catch (claimError) {
        // A second worker may have won the single pending -> in-flight CAS.
        // Re-read the authority. Only a non-pending row proves that race; a
        // still-pending row means the original error was not a harmless race.
        const current = await options.repository.findByInvoice(
          input.scope,
          input.invoiceId,
          input.mode,
        );
        if (current === null) throw claimError;
        assertZatcaInvoiceSubmissionReplay(current, candidate);
        if (current.state === 'pending') throw claimError;
        return current;
      }

      const request = {
        scope: inFlight.scope,
        terminalId: inFlight.terminalId,
        environment: inFlight.environment,
        mode: inFlight.mode,
        invoiceUuid: inFlight.invoiceUuid,
        invoiceHashBase64: bytesToBase64(inFlight.invoiceHash),
        invoiceBase64: bytesToBase64(inFlight.sealedInvoiceXml),
        productionSecret: inFlight.productionSecret,
      } as const;

      let result;
      try {
        result = await options.transport.submit(request);
      } catch (transportError) {
        // The port is contractually non-throwing for ordinary transport
        // ambiguity, but a defensive boundary here preserves the invariant if
        // an adapter violates that contract. We never attempt a second send.
        try {
          return await options.repository.markUncertain(input.scope, inFlight.submissionId, {
            resolvedAt: utcSecondAtOrAfter(clock, inFlight.requestStartedAt),
            uncertaintyReason: 'transport',
          });
        } catch (persistenceError) {
          const current = await safelyReadCurrent(
            options.repository,
            input.scope,
            input.invoiceId,
            input.mode,
          );
          if (current !== null && current.state !== 'pending') return current;
          throw new AggregateError(
            [transportError, persistenceError],
            'ZATCA request may have left Korvi, but its ambiguous outcome could not be persisted. The durable in-flight row must be reconciled and must not be resent automatically.',
            { cause: persistenceError },
          );
        }
      }

      const resolvedAt = utcSecondAtOrAfter(clock, inFlight.requestStartedAt);
      if (result.kind === 'uncertain') {
        return options.repository.markUncertain(input.scope, inFlight.submissionId, {
          resolvedAt,
          uncertaintyReason: result.reason,
          ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
        });
      }

      if (result.kind === 'rejected') {
        return options.repository.markRejected(input.scope, inFlight.submissionId, {
          resolvedAt,
          httpStatus: result.httpStatus,
          rejectionCode: result.rejectionCode,
        });
      }

      if (!acceptedMatchesMode(inFlight.mode, result.authorityStatus)) {
        return options.repository.markUncertain(input.scope, inFlight.submissionId, {
          resolvedAt,
          uncertaintyReason: 'response-invalid',
          httpStatus: result.httpStatus,
        });
      }

      if (inFlight.mode === 'reporting') {
        if (result.clearedInvoiceBase64 !== undefined) {
          return options.repository.markUncertain(input.scope, inFlight.submissionId, {
            resolvedAt,
            uncertaintyReason: 'response-invalid',
            httpStatus: result.httpStatus,
          });
        }
        return options.repository.markAccepted(input.scope, inFlight.submissionId, {
          resolvedAt,
          httpStatus: result.httpStatus,
          authorityStatus: 'REPORTED',
        });
      }

      if (result.clearedInvoiceBase64 === undefined) {
        return options.repository.markUncertain(input.scope, inFlight.submissionId, {
          resolvedAt,
          uncertaintyReason: 'response-invalid',
          httpStatus: result.httpStatus,
        });
      }
      let clearedInvoiceXml: Uint8Array;
      try {
        clearedInvoiceXml = decodeCanonicalBase64(result.clearedInvoiceBase64);
      } catch {
        return options.repository.markUncertain(input.scope, inFlight.submissionId, {
          resolvedAt,
          uncertaintyReason: 'response-invalid',
          httpStatus: result.httpStatus,
        });
      }
      if (clearedInvoiceXml.byteLength < 16) {
        return options.repository.markUncertain(input.scope, inFlight.submissionId, {
          resolvedAt,
          uncertaintyReason: 'response-invalid',
          httpStatus: result.httpStatus,
        });
      }
      return options.repository.markAccepted(input.scope, inFlight.submissionId, {
        resolvedAt,
        httpStatus: result.httpStatus,
        authorityStatus: 'CLEARED',
        clearedInvoiceXml,
      });
    },

    async reconcileUncertain(input) {
      const current = await options.repository.findByInvoice(
        input.scope,
        input.invoiceId,
        input.mode,
      );
      if (current === null) {
        throw new ZatcaInvoiceSubmissionError(
          'ZATCA submission does not exist for reconciliation.',
        );
      }
      if (current.state !== 'uncertain') {
        throw new ZatcaInvoiceSubmissionError(
          `ZATCA submission in state ${current.state} is not awaiting reconciliation.`,
        );
      }

      const resolvedAt = utcSecondAtOrAfter(clock, current.resolvedAt);
      if (input.outcome.kind === 'rejected') {
        return options.repository.markRejected(input.scope, current.submissionId, {
          resolvedAt,
          httpStatus: input.outcome.httpStatus,
          rejectionCode: input.outcome.rejectionCode,
        });
      }
      if (!acceptedMatchesMode(current.mode, input.outcome.authorityStatus)) {
        throw new ZatcaInvoiceSubmissionError(
          'ZATCA reconciliation authority status contradicts the immutable submission mode.',
        );
      }
      if (current.mode === 'reporting') {
        if (input.outcome.clearedInvoiceXml !== undefined) {
          throw new ZatcaInvoiceSubmissionError(
            'ZATCA reporting reconciliation cannot attach a cleared invoice.',
          );
        }
        return options.repository.markAccepted(input.scope, current.submissionId, {
          resolvedAt,
          httpStatus: input.outcome.httpStatus,
          authorityStatus: 'REPORTED',
        });
      }
      if (
        input.outcome.clearedInvoiceXml === undefined ||
        input.outcome.clearedInvoiceXml.byteLength < 16
      ) {
        throw new ZatcaInvoiceSubmissionError(
          'ZATCA clearance reconciliation requires the cleared invoice bytes.',
        );
      }
      return options.repository.markAccepted(input.scope, current.submissionId, {
        resolvedAt,
        httpStatus: input.outcome.httpStatus,
        authorityStatus: 'CLEARED',
        clearedInvoiceXml: Uint8Array.from(input.outcome.clearedInvoiceXml),
      });
    },
  };
}

function acceptedMatchesMode(
  mode: ZatcaInvoiceSubmissionMode,
  authorityStatus: 'REPORTED' | 'CLEARED',
): boolean {
  return (
    (mode === 'reporting' && authorityStatus === 'REPORTED') ||
    (mode === 'clearance' && authorityStatus === 'CLEARED')
  );
}

function utcSecond(clock: Clock): string {
  const value = clock.now();
  if (!Number.isFinite(value) || value < 0) {
    throw new ZatcaInvoiceSubmissionError('ZATCA submission clock is invalid.');
  }
  return new Date(Math.floor(value / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function utcSecondAtOrAfter(clock: Clock, floor: string): string {
  const observed = utcSecond(clock);
  return Date.parse(observed) < Date.parse(floor) ? floor : observed;
}

function decodeCanonicalBase64(value: string): Uint8Array {
  if (
    value.length < 1 ||
    value.length > MAX_CLEARED_INVOICE_BASE64_CHARACTERS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new ZatcaInvoiceSubmissionError('ZATCA cleared invoice is not canonical base64.');
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
  if (bytesToBase64(bytes) !== value) {
    throw new ZatcaInvoiceSubmissionError('ZATCA cleared invoice is not canonical base64.');
  }
  return bytes;
}

async function safelyReadCurrent(
  repository: ZatcaInvoiceSubmissionRepository,
  scope: TenantScope,
  invoiceId: string,
  mode: ZatcaInvoiceSubmissionMode,
): Promise<ZatcaDurableInvoiceSubmission | null> {
  try {
    return await repository.findByInvoice(scope, invoiceId, mode);
  } catch {
    return null;
  }
}
