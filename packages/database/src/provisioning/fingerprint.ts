import { createHash } from 'node:crypto';
import type { TenantTransition } from '@korvi/domain';

/**
 * Canonical fingerprints for control-plane operations.
 *
 * Same shape as the drawer's (apps/api/src/shifts/fingerprint.ts) and for the
 * same reasons: structured JSON rather than a joined string, because a name and
 * a suspension reason are free text and may contain any separator a hand-rolled
 * encoding might pick. The separators must come from the encoding and never
 * from field content.
 *
 * Both bind the acting operator. An operation id whose fingerprint ignores who
 * is using it is a bearer token for somebody else's operation: a second
 * operator replaying a colleague's id would be handed that colleague's result,
 * and the audit row would name the wrong person (ADR-0017, ADR-0018).
 *
 * Nothing derived by the server is included — not the tenant id it will mint,
 * not the timestamp, not the number of sessions a suspension will revoke —
 * because those are consequences of the request rather than part of it, and
 * including one would make a lawful retry hash differently.
 */
function digest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

export interface ProvisioningIntent {
  readonly slug: string;
  readonly name: string;
  readonly vatNumber: string | null;
  readonly vertical: string;
  readonly controlPlaneActorRef: string;
}

export function fingerprintProvisioning(intent: ProvisioningIntent): string {
  return digest(
    JSON.stringify([
      'tenant.provision.v1',
      intent.slug,
      intent.name,
      intent.vatNumber,
      intent.vertical,
      intent.controlPlaneActorRef,
    ]),
  );
}

export interface LifecycleIntent {
  readonly transition: TenantTransition;
  readonly tenantId: string;
  readonly controlPlaneActorRef: string;
  /** Null for every transition but suspension, which requires one. */
  readonly reason: string | null;
}

export function fingerprintLifecycle(intent: LifecycleIntent): string {
  return digest(
    JSON.stringify([
      'tenant.lifecycle.v1',
      intent.transition,
      intent.tenantId,
      intent.controlPlaneActorRef,
      intent.reason,
    ]),
  );
}
