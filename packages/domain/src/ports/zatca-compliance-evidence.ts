import type { TenantScope } from './persistence.js';
import type {
  RecordZatcaAcceptedComplianceEvidenceInput,
  ZatcaAcceptedComplianceEvidence,
} from '../zatca/compliance-evidence.js';

/**
 * Append-only authority for successful ZATCA compliance-check evidence.
 * Implementations MUST derive CCSID identity from the referenced issued
 * provisioning attempt and MUST operate under tenant RLS.
 */
export interface ZatcaComplianceEvidenceRepository {
  findById(scope: TenantScope, evidenceId: string): Promise<ZatcaAcceptedComplianceEvidence | null>;

  recordAccepted(
    scope: TenantScope,
    input: RecordZatcaAcceptedComplianceEvidenceInput,
  ): Promise<ZatcaAcceptedComplianceEvidence>;
}
