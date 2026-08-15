import { WeakCredentialError, assertNewPasswordAcceptable } from '@korvi/domain';
import { OwnerBootstrapRefusedError, acceptOwnerBootstrap } from '@korvi/database';
import { hashPassword } from '../auth/password.js';
import type { PrismaClient } from '@korvi/database';
import type { ScryptProfile } from '../auth/password.js';

/**
 * The public half of owner bootstrap, as the API layer sees it.
 *
 * One method, two arguments, and neither of them is authority. There is no
 * parameter here into which a tenant, a user, a role or an email could be
 * threaded — the tenant comes from a verified signature and everything else
 * from the invitation row, so the compiler enforces what a handler would
 * otherwise have to remember (ADR-0021).
 *
 * The result vocabulary is deliberately two values wide. `weak-password` is a
 * fact about the caller's own input and tells them nothing about the merchant;
 * `invalid-capability` covers every other refusal there is.
 */

export type BootstrapFailureReason = 'weak-password' | 'invalid-capability';

export type BootstrapResult =
  | { readonly outcome: 'success' }
  | { readonly outcome: 'failure'; readonly reason: BootstrapFailureReason };

export interface OwnerBootstrapService {
  accept(token: string, password: string): Promise<BootstrapResult>;
}

export interface OwnerBootstrapDeps {
  readonly prisma: PrismaClient;
  readonly signingKey: string;
  readonly scrypt?: ScryptProfile | undefined;
}

export function createOwnerBootstrapService(deps: OwnerBootstrapDeps): OwnerBootstrapService {
  return {
    async accept(token, password) {
      // Password strength first, always, and before the capability is looked
      // at. The other order would make "weak password" mean "your token would
      // have been honoured", which is exactly the oracle this must not be.
      try {
        assertNewPasswordAcceptable(password);
      } catch (error) {
        if (error instanceof WeakCredentialError) {
          return { outcome: 'failure', reason: 'weak-password' };
        }
        throw error;
      }

      try {
        await acceptOwnerBootstrap(
          deps.prisma,
          deps.signingKey,
          token,
          // Korvi's own implementation and profile. A second hashing path here
          // would be a credential the login route could not verify.
          (secret) => hashPassword(secret, deps.scrypt),
          password,
        );
        return { outcome: 'success' };
      } catch (error) {
        // Every deliberate refusal collapses to one answer. Anything else is
        // rethrown: an unexpected failure must not be laundered into a tidy
        // "your token was bad".
        if (error instanceof OwnerBootstrapRefusedError) {
          return { outcome: 'failure', reason: 'invalid-capability' };
        }
        throw error;
      }
    },
  };
}
