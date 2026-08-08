import { TenantContextError } from './errors.js';
import type { PrismaClient } from './client.js';

/**
 * Tenant context for Row-Level Security.
 *
 * The policies in the RLS migration read `app.tenant_id`. Establishing it
 * correctly is the whole security boundary, and there is exactly one safe way
 * to do it under a connection pool:
 *
 *   SET LOCAL, inside a transaction.
 *
 * `SET` (without LOCAL) persists for the life of the connection. A pooled
 * connection is handed to the next request, so a plain SET leaks one tenant's
 * context into another tenant's query — the precise failure RLS is meant to
 * prevent. SET LOCAL is scoped to the transaction and reverts on commit or
 * rollback, so it cannot outlive the request.
 *
 * Prisma has no first-class hook for per-transaction session variables, which
 * is why this wrapper exists rather than a middleware: middleware does not
 * reliably share the transaction's connection.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The client handed to a transaction callback.
 *
 * Prisma withholds the connection-lifecycle and extension methods inside a
 * transaction, so this mirrors its deny list. Naming it here means callers
 * write `TransactionClient` instead of repeating an Omit that has to stay in
 * step with Prisma's.
 */
export type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$extends' | '$use'
>;

/**
 * Run `work` with the tenant context set for its whole transaction.
 *
 * Everything inside sees only that tenant's rows, enforced by Postgres rather
 * than by the query being written correctly.
 */
export async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  if (!UUID_PATTERN.test(tenantId)) {
    // Validated before interpolation. The value reaches SQL through a
    // parameter below, but rejecting a malformed id early also stops a
    // mistyped tenant from silently matching no rows and looking like an
    // empty database.
    throw new TenantContextError(`Not a tenant UUID: "${tenantId}".`);
  }

  return prisma.$transaction(async (tx) => {
    // Parameterised: set_config is a function call, so the value is bound
    // rather than concatenated into the statement.
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, TRUE)`;
    return work(tx);
  });
}

/**
 * Run `work` with no tenant context.
 *
 * Only for genuinely global data — the national catalogue, migrations,
 * operational tooling. Under RLS this sees nothing in any tenant-owned table,
 * which is the correct and safe outcome.
 */
export async function withoutTenant<T>(
  prisma: PrismaClient,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', '', TRUE)`;
    return work(tx);
  });
}

/**
 * Deterministic slug normalisation.
 *
 * The same rule has to run in the resolver and in whatever writes the slug, or
 * a tenant that registered "Korvi" becomes unreachable by "korvi". NFKC first,
 * because a compatibility-composed character is the same slug to a human and a
 * different byte string to Postgres.
 *
 * Returns the empty string for anything that is not a plausible slug, and the
 * caller refuses to query on that rather than probing with rubbish.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function normalizeTenantSlug(input: string): string {
  const candidate = input.normalize('NFKC').trim().toLowerCase();
  return SLUG_PATTERN.test(candidate) ? candidate : '';
}

/**
 * Run `work` with the login-resolution setting established, and no tenant.
 *
 * This is the one read that happens before a scope exists: authentication has
 * to turn a submitted slug into the tenant that will become the scope. The
 * migration backs it with a SELECT-only policy keyed on `app.login_tenant_slug`
 * (ADR-0012), so inside this transaction exactly one tenant row is visible —
 * the one whose slug was submitted — and nothing at all is writable.
 *
 * `app.tenant_id` is left empty on purpose. Every other table keys its policy
 * on that, so users, products and sales are invisible here, which is what makes
 * this narrow enough to be safe.
 */
export async function withLoginSlug<T>(
  prisma: PrismaClient,
  slug: string,
  work: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  const normalized = normalizeTenantSlug(slug);
  if (normalized === '') {
    throw new TenantContextError('Not a tenant slug.');
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', '', TRUE)`;
    // Parameterised: set_config is a function call, so the submitted value is
    // bound rather than concatenated into the statement.
    await tx.$executeRaw`SELECT set_config('app.login_tenant_slug', ${normalized}, TRUE)`;
    return work(tx);
  });
}
