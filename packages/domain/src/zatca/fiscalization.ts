import { DomainError } from '../errors.js';
import type { TenantScope } from '../ports/persistence.js';
import type { ZatcaSellerFiscalProfile } from './phase2.js';

export class ZatcaFiscalizationError extends DomainError {
  public override readonly name = 'ZatcaFiscalizationError';
}

export interface ZatcaFiscalReservationBase {
  readonly scope: TenantScope;
  readonly invoiceId: string;
  readonly terminalId: string;
  readonly invoiceCounterValue: string;
  readonly previousInvoiceHash: string;
  readonly seller: ZatcaSellerFiscalProfile;
  readonly reservedAt: string;
}

export interface ZatcaReservedFiscalization extends ZatcaFiscalReservationBase {
  readonly state: 'reserved';
}

export interface ZatcaSealedFiscalization extends ZatcaFiscalReservationBase {
  readonly state: 'sealed';
  readonly invoiceHash: Uint8Array;
  readonly sealedInvoiceXml: Uint8Array;
  readonly qrCodeBase64: string;
  readonly signatureValueBase64: string;
  readonly sealedAt: string;
}

export type ZatcaDurableFiscalization = ZatcaReservedFiscalization | ZatcaSealedFiscalization;

export interface ReserveZatcaFiscalizationInput {
  readonly invoiceId: string;
  readonly terminalId: string;
  readonly reservedAt: string;
}

export interface SealZatcaFiscalizationInput {
  readonly invoiceId: string;
  readonly terminalId: string;
  readonly invoiceHash: Uint8Array;
  readonly sealedInvoiceXml: Uint8Array;
  readonly qrCodeBase64: string;
  readonly signatureValueBase64: string;
  readonly sealedAt: string;
}

export interface ZatcaFiscalizationRepository {
  readSellerProfile(scope: TenantScope): Promise<ZatcaSellerFiscalProfile | null>;

  upsertSellerProfile(
    scope: TenantScope,
    profile: ZatcaSellerFiscalProfile,
    updatedAt: string,
  ): Promise<ZatcaSellerFiscalProfile>;

  findByInvoice(scope: TenantScope, invoiceId: string): Promise<ZatcaDurableFiscalization | null>;

  /**
   * Reserve the next terminal-local ICV together with the exact PIH and an
   * immutable fiscal-profile snapshot. Replays converge on the first durable
   * reservation.
   *
   * A terminal may have only one unsealed reservation because invoice N's hash
   * is the PIH authority for invoice N+1.
   */
  reserve(
    scope: TenantScope,
    input: ReserveZatcaFiscalizationInput,
  ): Promise<ZatcaDurableFiscalization>;

  /**
   * Freeze signed invoice evidence and advance the terminal chain in the same
   * transaction. Replaying the exact evidence is safe; divergent evidence for
   * an already sealed invoice is refused.
   */
  seal(scope: TenantScope, input: SealZatcaFiscalizationInput): Promise<ZatcaSealedFiscalization>;
}
