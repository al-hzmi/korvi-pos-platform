import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { authoritativeTerminalId } from '../routes/business.js';
import type { AuthenticatedPrincipal } from '@korvi/domain';

const here = dirname(fileURLToPath(import.meta.url));
const businessSource = readFileSync(join(here, '../routes/business.ts'), 'utf8');
const nativeSource = readFileSync(join(here, '../native-auth/service.ts'), 'utf8');

const BASE: AuthenticatedPrincipal = {
  tenantId: '018f2000-0000-7000-8000-00000000000a',
  tenantSlug: 'korvi-a',
  userId: '018f2000-0000-7000-8000-0000000000a4',
  sessionId: '018f2000-0000-7000-8000-0000000000f1',
  email: 'sara@korvi-a.test',
  displayName: 'سارة',
  roles: ['cashier'],
  permissions: ['product.read', 'sale.create', 'shift.open', 'shift.close'],
  maxDiscountBasisPoints: 0n,
  branchId: '018f2000-0000-7000-8000-0000000000a1',
};
const TERMINAL_A = '018f2000-0000-7000-8000-0000000000a2';
const TERMINAL_B = '018f2000-0000-7000-8000-0000000000b2';

describe('native terminal authority', () => {
  it('accepts exactly the terminal bound into an installed principal', () => {
    const native = { ...BASE, terminalId: TERMINAL_A };
    expect(authoritativeTerminalId(native, TERMINAL_A)).toBe(TERMINAL_A);
  });

  it('rejects substitution with another terminal even inside the same branch', () => {
    const native = { ...BASE, terminalId: TERMINAL_A };
    expect(authoritativeTerminalId(native, TERMINAL_B)).toBeNull();
  });

  it('leaves browser terminal selection unchanged when no device binding exists', () => {
    expect(authoritativeTerminalId(BASE, TERMINAL_B)).toBe(TERMINAL_B);
  });

  it('fences every till-addressed business path through the same authority resolver', () => {
    expect(
      businessSource.match(/authoritativeTerminalId\(principal, parsed\.data\.terminalId\)/g),
    ).toHaveLength(4);
    expect(businessSource).toContain(
      'const authoritative = authoritativeTerminalId(principal, terminalId);',
    );
  });

  it('derives native terminal identity from both challenge login and persisted session', () => {
    expect(nativeSource).toMatch(
      /branchId: challenge\.branchId,\s+terminalId: challenge\.terminalId,\s+};\s+const binding/,
    );
    expect(nativeSource).toMatch(
      /branchId: context\.branchId,\s+terminalId: context\.terminalId,\s+},\s+binding:/,
    );
  });
});
