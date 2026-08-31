/**
 * What the browser is allowed to know.
 *
 * Deliberately narrower than the server's own types. Every field here is one
 * the API actually sends today; nothing is optimistic, and nothing carries
 * authority. Money is a string of halalas and quantity a string scaled by
 * 1000, exactly as they cross the wire (ADR-0002).
 */

import type { PriceMode } from '@korvi/domain';

export interface Principal {
  readonly user: { readonly id: string; readonly email: string; readonly displayName: string };
  readonly tenant: { readonly id: string; readonly slug?: string };
  readonly session: { readonly id: string };
  readonly roles: readonly string[];
  /** Used only to hide affordances. The API is the authority, always. */
  readonly permissions: readonly string[];
  readonly branchId: string | null;
}

export interface TerminalSummary {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly branchId: string;
}

/**
 * The tenant settings a till must know to render a total the server agrees
 * with. Read on the server from `tenant_settings` under the session's scope;
 * the browser cannot send either field and cannot change either one.
 */
export interface TillSettings {
  readonly priceMode: PriceMode;
  readonly currency: string;
}

export interface TerminalsResponse {
  readonly branchId: string;
  readonly settings: TillSettings;
  readonly terminals: readonly TerminalSummary[];
}

export interface ProductSummary {
  readonly id: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string | null;
  readonly priceMinor: string;
  readonly vatBasisPoints: number;
  readonly primaryBarcode: string | null;
  readonly trackInventory: boolean;
}

/**
 * The server-created catalogue row returned by POST /v1/admin/products.
 *
 * It is intentionally not a write model: isActive, trackInventory, the VAT
 * fallback and timestamps are facts the server decided, never fields the
 * browser is allowed to assert.
 */
export interface AdminProductBootstrap extends ProductSummary {
  readonly unitLabel: string;
  readonly isActive: true;
  readonly createdAt: string;
}

export interface AdminProductCreateInput {
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn?: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string;
  /** Exact halalas as an integer string. */
  readonly priceMinor: string;
  readonly barcode?: string | null;
}

export type OnboardingCheckKey =
  | 'tenant-active'
  | 'settings-present'
  | 'active-branch'
  | 'active-terminal'
  | 'viable-administrator'
  | 'active-product';

export type OnboardingRemediation =
  | 'tenant-lifecycle'
  | 'merchant-settings'
  | 'branch-terminal-admin'
  | 'member-role-admin'
  | 'product-catalogue';

export interface OnboardingReadinessCheck {
  readonly key: OnboardingCheckKey;
  readonly ready: boolean;
  readonly blocker: string | null;
  readonly remediation: OnboardingRemediation | null;
}

/** Evidence-derived current truth; there is no persisted completion flag. */
export interface OnboardingReadiness {
  readonly ready: boolean;
  readonly checks: readonly OnboardingReadinessCheck[];
}

export interface ShiftSummary {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly status: string;
  readonly openingFloatMinor: string;
  readonly openedAt: string;
}

export interface SaleSummaryLine {
  readonly lineNumber: number;
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly quantityScaled: string;
  readonly unitPriceMinor: string;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
}

export interface SaleSummary {
  readonly saleId: string;
  readonly operationId: string;
  readonly sequence: number;
  readonly invoiceNumber: string;
  readonly issuedAt: string;
  readonly currency: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly shiftId: string;
  readonly cashierName: string;
  readonly lines: readonly SaleSummaryLine[];
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly cashReceivedMinor: string;
  readonly changeMinor: string;
}

export interface CheckoutResponse {
  readonly sale: SaleSummary;
  readonly replayed: boolean;
}

/** Exactly what a checkout may assert. Anything else is the server's business. */
export interface CheckoutRequest {
  readonly operationId: string;
  readonly terminalId: string;
  readonly cashReceivedMinor: string;
  readonly lines: readonly { readonly productId: string; readonly quantityScaled: string }[];
}

/**
 * The owner's dashboard, exactly as the server computed it.
 *
 * Money is a decimal string of halalas and stays one until it is formatted for
 * display. Nothing here is derived in the browser: a figure an owner checks
 * against their tills must come from the same place the tills wrote to.
 */
export interface DashboardSummary {
  readonly activeProductCount: number;
  readonly terminalCount: number;
  readonly openShiftCount: number;
  readonly salesLast24HoursCount: number;
  readonly grossSalesLast24HoursMinor: string;
  readonly vatLast24HoursMinor: string;
  readonly currency: string;
  readonly since: string;
}

/** A bounded keyset page returned by merchant administration. */
export interface AdminPage<T> {
  readonly items: readonly T[];
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

/**
 * Merchant-visible tenant settings. The immutable commercial fields are shown
 * so an administrator can understand the merchant, but only the editable
 * fields appear in `AdminSettingsPatch`.
 */
export interface AdminTenantSettings {
  readonly tenantId: string;
  readonly vertical: string;
  readonly priceMode: string;
  readonly defaultVatBasisPoints: number;
  readonly currency: string;
  readonly requireBarcode: boolean;
  readonly allowWeightedItems: boolean;
  readonly trackInventory: boolean;
  readonly allowNegativeStock: boolean;
  readonly enableProductImages: boolean;
  readonly receiptHeaderAr: string | null;
  readonly receiptFooterAr: string | null;
}

export interface AdminSettingsPatch {
  readonly requireBarcode?: boolean;
  readonly allowWeightedItems?: boolean;
  readonly trackInventory?: boolean;
  readonly allowNegativeStock?: boolean;
  readonly enableProductImages?: boolean;
  readonly receiptHeaderAr?: string | null;
  readonly receiptFooterAr?: string | null;
}

export interface AdminBranch {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
}

/** Read-only branch identity exposed under inventory.read, not settings.manage. */
export interface InventoryBranch {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
}

export interface InventoryBalanceRow {
  readonly branchId: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string;
  /** Exact quantity scaled by 1000. */
  readonly quantityScaled: string;
  /** Exact server revision a later absolute count must observe. */
  readonly revision: string;
}

export interface InventoryBranchPage {
  readonly rows: readonly InventoryBranch[];
  readonly nextCursor: string | null;
}

export interface InventoryBalancePage {
  readonly rows: readonly InventoryBalanceRow[];
  readonly nextCursor: string | null;
}

export interface AdminTerminal {
  readonly id: string;
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly lastSeenAt: string | null;
}

export interface AdminMember {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string;
  readonly userActive: boolean;
  readonly membershipStatus: string | null;
  readonly defaultBranchId: string | null;
  /** Whether a credential exists; credential material is never sent. */
  readonly hasCredential: boolean;
  readonly roleIds: readonly string[];
  readonly lastLoginAt: string | null;
}

export interface AdminRole {
  readonly id: string;
  readonly key: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isSystem: boolean;
  readonly maxDiscountBasisPoints: number;
  readonly permissions: readonly string[];
}

export interface AdminAccessChange {
  readonly member: AdminMember;
  readonly revokedSessions: number;
}

export interface AdminRoleAssignmentResult {
  readonly member: AdminMember;
  readonly changed: boolean;
}
