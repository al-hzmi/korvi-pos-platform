import { describe, expect, it, vi } from 'vitest';
import {
  ZatcaInvoiceSubmissionError,
  assertZatcaInvoiceSubmissionReplay,
  prepareZatcaInvoiceSubmission,
  tenantId,
  type TenantScope,
  type ZatcaAcceptedDurableInvoiceSubmission,
  type ZatcaDurableInvoiceSubmission,
  type ZatcaInvoiceSubmissionMode,
  type ZatcaInvoiceSubmissionPort,
  type ZatcaInvoiceSubmissionRepository,
  type ZatcaInvoiceSubmissionUncertaintyReason,
  type ZatcaInFlightInvoiceSubmission,
  type ZatcaPendingInvoiceSubmission,
  type ZatcaRejectedDurableInvoiceSubmission,
  type ZatcaUncertainDurableInvoiceSubmission,
} from '@korvi/domain';
import {
  createZatcaInvoiceSubmissionService,
  type SubmitDurableZatcaInvoiceInput,
} from '../zatca/invoice-submission-service.js';

const D = {
  tenant: '018f6a00-0000-7000-8000-0000000002a1',
  invoice: '018f6a00-0000-7000-8000-0000000002a2',
  terminal: '018f6a00-0000-7000-8000-0000000002a3',
  invoiceUuid: '018f6a00-0000-7000-8000-0000000002a4',
  submission1: '018f6a00-0000-7000-8000-0000000002a5',
  submission2: '018f6a00-0000-7000-8000-0000000002a6',
  submission3: '018f6a00-0000-7000-8000-0000000002a7',
} as const;
const NOW = Date.parse('2026-09-11T23:10:00Z');
const XML = new TextEncoder().encode(
  '<?xml version="1.0"?><Invoice><ID>sealed-gate-40</ID></Invoice>',
);
const HASH = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

function command(
  changes: Partial<SubmitDurableZatcaInvoiceInput> = {},
): SubmitDurableZatcaInvoiceInput {
  return {
    scope: { tenantId: tenantId(D.tenant) },
    invoiceId: D.invoice,
    terminalId: D.terminal,
    environment: 'production',
    mode: 'reporting',
    invoiceUuid: D.invoiceUuid,
    invoiceHash: HASH,
    sealedInvoiceXml: XML,
    productionSecret: { provider: 'test-vault', secretId: `sha256:${'a'.repeat(64)}` },
    ...changes,
  };
}

function ids(...values: string[]) {
  let index = 0;
  return {
    next: vi.fn(() => {
      const value = values[index] ?? values.at(-1);
      index += 1;
      if (value === undefined) throw new Error('test id sequence exhausted');
      return value;
    }),
  };
}

class MemorySubmissionRepository implements ZatcaInvoiceSubmissionRepository {
  current: ZatcaDurableInvoiceSubmission | null = null;
  readonly events: string[] = [];

  async findByInvoice(
    _scope: TenantScope,
    _invoiceId: string,
    _mode: ZatcaInvoiceSubmissionMode,
  ): Promise<ZatcaDurableInvoiceSubmission | null> {
    this.events.push('find');
    return this.current;
  }

  async reservePending(
    _scope: TenantScope,
    submission: ZatcaPendingInvoiceSubmission,
  ): Promise<ZatcaDurableInvoiceSubmission> {
    this.events.push('reserve');
    if (this.current === null) {
      this.current = submission;
      return submission;
    }
    assertZatcaInvoiceSubmissionReplay(this.current, submission);
    return this.current;
  }

  async markRequestStarted(
    _scope: TenantScope,
    submissionId: string,
    requestStartedAt: string,
  ): Promise<ZatcaInFlightInvoiceSubmission> {
    this.events.push('mark-in-flight');
    const current = this.current;
    if (
      current === null ||
      current.submissionId !== submissionId ||
      current.state !== 'pending' ||
      current.attemptCount !== 0
    ) {
      throw new ZatcaInvoiceSubmissionError('stale state refused');
    }
    const inFlight: ZatcaInFlightInvoiceSubmission = {
      ...current,
      state: 'in-flight',
      attemptCount: 1,
      requestStartedAt,
    };
    this.current = inFlight;
    return inFlight;
  }

  async markAccepted(
    _scope: TenantScope,
    submissionId: string,
    result: {
      readonly resolvedAt: string;
      readonly httpStatus: number;
      readonly authorityStatus: 'REPORTED' | 'CLEARED';
      readonly clearedInvoiceXml?: Uint8Array;
    },
  ): Promise<ZatcaAcceptedDurableInvoiceSubmission> {
    this.events.push('mark-accepted');
    const current = this.expectResolvable(submissionId);
    const accepted: ZatcaAcceptedDurableInvoiceSubmission = {
      ...current,
      state: 'accepted',
      attemptCount: 1,
      resolvedAt: result.resolvedAt,
      httpStatus: result.httpStatus,
      authorityStatus: result.authorityStatus,
      ...(result.clearedInvoiceXml === undefined
        ? {}
        : { clearedInvoiceXml: Uint8Array.from(result.clearedInvoiceXml) }),
    };
    this.current = accepted;
    return accepted;
  }

  async markRejected(
    _scope: TenantScope,
    submissionId: string,
    result: {
      readonly resolvedAt: string;
      readonly httpStatus: number;
      readonly rejectionCode: string;
    },
  ): Promise<ZatcaRejectedDurableInvoiceSubmission> {
    this.events.push('mark-rejected');
    const current = this.expectResolvable(submissionId);
    const rejected: ZatcaRejectedDurableInvoiceSubmission = {
      ...current,
      state: 'rejected',
      attemptCount: 1,
      resolvedAt: result.resolvedAt,
      httpStatus: result.httpStatus,
      rejectionCode: result.rejectionCode,
    };
    this.current = rejected;
    return rejected;
  }

  async markUncertain(
    _scope: TenantScope,
    submissionId: string,
    result: {
      readonly resolvedAt: string;
      readonly uncertaintyReason: ZatcaInvoiceSubmissionUncertaintyReason;
      readonly httpStatus?: number;
    },
  ): Promise<ZatcaUncertainDurableInvoiceSubmission> {
    this.events.push('mark-uncertain');
    const current = this.current;
    if (
      current === null ||
      current.submissionId !== submissionId ||
      current.state !== 'in-flight'
    ) {
      throw new ZatcaInvoiceSubmissionError('stale state refused');
    }
    const uncertain: ZatcaUncertainDurableInvoiceSubmission = {
      ...current,
      state: 'uncertain',
      attemptCount: 1,
      resolvedAt: result.resolvedAt,
      uncertaintyReason: result.uncertaintyReason,
      ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
    };
    this.current = uncertain;
    return uncertain;
  }

  private expectResolvable(
    submissionId: string,
  ): ZatcaInFlightInvoiceSubmission | ZatcaUncertainDurableInvoiceSubmission {
    const current = this.current;
    if (
      current === null ||
      current.submissionId !== submissionId ||
      (current.state !== 'in-flight' && current.state !== 'uncertain')
    ) {
      throw new ZatcaInvoiceSubmissionError('stale state refused');
    }
    return current;
  }
}

function service(
  repository: MemorySubmissionRepository,
  transport: ZatcaInvoiceSubmissionPort,
  idValues = [D.submission1, D.submission2, D.submission3],
) {
  return createZatcaInvoiceSubmissionService({
    repository,
    transport,
    idGenerator: ids(...idValues),
    clock: { now: () => NOW },
  });
}

describe('Gate 40 durable ZATCA submission coordinator', () => {
  it('persists in-flight before network and lets only one concurrent caller send', async () => {
    const repository = new MemorySubmissionRepository();
    let release!: (result: Awaited<ReturnType<ZatcaInvoiceSubmissionPort['submit']>>) => void;
    const transport = {
      submit: vi.fn(
        () =>
          new Promise<Awaited<ReturnType<ZatcaInvoiceSubmissionPort['submit']>>>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const coordinator = service(repository, transport);

    const first = coordinator.submit(command());
    await vi.waitFor(() => expect(transport.submit).toHaveBeenCalledTimes(1));
    expect(repository.current?.state).toBe('in-flight');
    expect(repository.events.slice(0, 2)).toEqual(['reserve', 'mark-in-flight']);

    const second = await coordinator.submit(command());
    expect(second.state).toBe('in-flight');
    expect(second.submissionId).toBe(D.submission1);
    expect(transport.submit).toHaveBeenCalledTimes(1);

    release({ kind: 'accepted', httpStatus: 200, authorityStatus: 'REPORTED' });
    const accepted = await first;
    expect(accepted.state).toBe('accepted');
    expect(transport.submit).toHaveBeenCalledTimes(1);

    const replay = await coordinator.submit(command());
    expect(replay.state).toBe('accepted');
    expect(replay.submissionId).toBe(D.submission1);
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it('persists authority ambiguity and never blindly resends it', async () => {
    const repository = new MemorySubmissionRepository();
    const transport = {
      submit: vi.fn(async () => ({
        kind: 'uncertain' as const,
        reason: 'transport' as const,
        httpStatus: 503,
      })),
    };
    const coordinator = service(repository, transport);

    const uncertain = await coordinator.submit(command());
    expect(uncertain).toMatchObject({
      state: 'uncertain',
      attemptCount: 1,
      uncertaintyReason: 'transport',
      httpStatus: 503,
    });
    expect(transport.submit).toHaveBeenCalledTimes(1);

    const replay = await coordinator.submit(command());
    expect(replay.state).toBe('uncertain');
    expect(transport.submit).toHaveBeenCalledTimes(1);

    const reconciled = await coordinator.reconcileUncertain({
      scope: command().scope,
      invoiceId: D.invoice,
      mode: 'reporting',
      outcome: { kind: 'accepted', httpStatus: 200, authorityStatus: 'REPORTED' },
    });
    expect(reconciled.state).toBe('accepted');
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it('converts an unexpected adapter throw into durable uncertainty without retrying', async () => {
    const repository = new MemorySubmissionRepository();
    const transport = {
      submit: vi.fn(async () => {
        throw new Error('socket vanished after write');
      }),
    };
    const coordinator = service(repository, transport);

    const uncertain = await coordinator.submit(command());
    expect(uncertain).toMatchObject({ state: 'uncertain', uncertaintyReason: 'transport' });
    expect(transport.submit).toHaveBeenCalledTimes(1);

    await coordinator.submit(command());
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it('refuses conflicting immutable replay before a second network attempt', async () => {
    const repository = new MemorySubmissionRepository();
    const transport = {
      submit: vi.fn(async () => ({
        kind: 'uncertain' as const,
        reason: 'transport' as const,
      })),
    };
    const coordinator = service(repository, transport);
    await coordinator.submit(command());

    const changedHash = Uint8Array.from(HASH);
    changedHash[0] = 1;
    await expect(coordinator.submit(command({ invoiceHash: changedHash }))).rejects.toThrow(
      /different immutable request identity/,
    );
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it('treats an accepted authority status that contradicts mode as uncertain', async () => {
    const repository = new MemorySubmissionRepository();
    const transport = {
      submit: vi.fn(async () => ({
        kind: 'accepted' as const,
        httpStatus: 200,
        authorityStatus: 'CLEARED' as const,
        clearedInvoiceBase64: Buffer.from(XML).toString('base64'),
      })),
    };
    const coordinator = service(repository, transport);

    await expect(coordinator.submit(command())).resolves.toMatchObject({
      state: 'uncertain',
      uncertaintyReason: 'response-invalid',
    });
    expect(transport.submit).toHaveBeenCalledTimes(1);
  });

  it('persists canonical cleared invoice bytes for clearance and never regenerates request bytes', async () => {
    const repository = new MemorySubmissionRepository();
    const cleared = new TextEncoder().encode('<Invoice><ID>cleared-authority-copy</ID></Invoice>');
    const transport = {
      submit: vi.fn(async (_request: Parameters<ZatcaInvoiceSubmissionPort['submit']>[0]) => ({
        kind: 'accepted' as const,
        httpStatus: 200,
        authorityStatus: 'CLEARED' as const,
        clearedInvoiceBase64: Buffer.from(cleared).toString('base64'),
      })),
    };
    const coordinator = service(repository, transport);

    const accepted = await coordinator.submit(command({ mode: 'clearance' }));
    expect(accepted.state).toBe('accepted');
    if (accepted.state !== 'accepted') throw new Error('expected accepted');
    expect(accepted.authorityStatus).toBe('CLEARED');
    expect(accepted.clearedInvoiceXml).toEqual(cleared);
    expect(transport.submit).toHaveBeenCalledTimes(1);
    const outbound = transport.submit.mock.calls[0]?.[0];
    expect(outbound?.invoiceUuid).toBe(D.invoiceUuid);
    expect(outbound?.invoiceHashBase64).toBe(Buffer.from(HASH).toString('base64'));
    expect(outbound?.invoiceBase64).toBe(Buffer.from(XML).toString('base64'));
  });

  it('does not let reconciliation itself call transport or resolve a non-uncertain row', async () => {
    const repository = new MemorySubmissionRepository();
    repository.current = prepareZatcaInvoiceSubmission({
      submissionId: D.submission1,
      ...command(),
      queuedAt: '2026-09-11T23:10:00Z',
    });
    const transport = { submit: vi.fn() } as unknown as ZatcaInvoiceSubmissionPort;
    const coordinator = service(repository, transport);

    await expect(
      coordinator.reconcileUncertain({
        scope: command().scope,
        invoiceId: D.invoice,
        mode: 'reporting',
        outcome: { kind: 'rejected', httpStatus: 400, rejectionCode: 'MANUAL' },
      }),
    ).rejects.toThrow(/not awaiting reconciliation/);
    expect(transport.submit).not.toHaveBeenCalled();
  });
});
