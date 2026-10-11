import type { TenantScope } from './persistence.js';
import type { ZatcaCsidBinding } from '../zatca/csid-lifecycle.js';

/**
 * Provenance required before a Production CSID can become stamping authority.
 * The source attempt is the durable ZATCA issuance record; callers cannot mint
 * an active binding from certificate/key/secret material that lacks that proof.
 */
export interface ActivateZatcaCsidBindingInput {
  readonly sourceAttemptId: string;
  readonly binding: ZatcaCsidBinding;
  /** Exact UTC second at which this credential becomes the terminal authority. */
  readonly activatedAt: string;
}

/**
 * Durable authority for the single active CSID of a tenant terminal.
 *
 * Reads are intentionally terminal-scoped. Invoice sealing must resolve this
 * repository itself rather than accepting a credential or secret handle from a
 * request/caller. Activation atomically supersedes the previous active binding.
 */
export interface ZatcaCsidBindingRepository {
  findActiveForTerminal(scope: TenantScope, terminalId: string): Promise<ZatcaCsidBinding | null>;
  activate(scope: TenantScope, input: ActivateZatcaCsidBindingInput): Promise<ZatcaCsidBinding>;
}
