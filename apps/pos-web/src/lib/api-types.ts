/**
 * What the browser is allowed to know.
 *
 * Deliberately narrower than the server's own types. Every field here is one
 * the API actually sends today; nothing is optimistic, and nothing carries
 * authority. Money is a string of halalas and quantity a string scaled by
 * 1000, exactly as they cross the wire (ADR-0002).
 */

import type { PriceMode, RestaurantOrderType, Vertical } from '@korvi/domain';

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
  readonly vertical?: Vertical;
  readonly enableProductImages?: boolean;
}

export interface TerminalsResponse {
  readonly branchId: string;
  readonly settings: TillSettings;
  readonly terminals: readonly TerminalSummary[];
}

export interface RestaurantFloorZone {
  readonly id: string;
  readonly nameAr: string;
  readonly sortOrder: number;
}

export interface RestaurantFloorTable {
  readonly id: string;
  readonly zoneId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly capacity: number | null;
}

export interface RestaurantFloorResponse {
  readonly branchId: string;
  readonly zones: readonly RestaurantFloorZone[];
  readonly tables: readonly RestaurantFloorTable[];
}

export interface RestaurantOrderLine {
  readonly id: string;
  readonly lineNumber: number;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitPriceMinor: string;
  readonly vatBasisPoints: number;
  readonly quantityScaled: string;
  readonly preparationNote: string | null;
  readonly preparationOptions: string | null;
  readonly trackInventory: boolean | null;
}

export interface RestaurantOrderSummary {
  readonly id: string;
  readonly branchId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly tableId: string | null;
  readonly tableCode: string | null;
  readonly tableNameAr: string | null;
  readonly orderType: RestaurantOrderType;
  readonly status: 'open' | 'cancelled' | 'settled';
  readonly revision: string;
  readonly priceMode: string;
  readonly currency: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly closedReason: string | null;
  readonly lineCount: number;
}

export interface RestaurantOrderDetail extends RestaurantOrderSummary {
  readonly lines: readonly RestaurantOrderLine[];
}

export interface RestaurantOrderMutationResult {
  readonly order: RestaurantOrderDetail;
  readonly replayed: boolean;
}

export interface RestaurantOrderCreateRequest {
  readonly operationId: string;
  readonly terminalId: string;
  readonly orderType: RestaurantOrderType;
  readonly tableId: string | null;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantityScaled: string;
    readonly preparationNote: string | null;
    readonly preparationOptions: string | null;
  }[];
}

export type RestaurantOrderReplaceLine =
  | {
      readonly lineId: string;
      readonly quantityScaled: string;
      readonly preparationNote: string | null;
      readonly preparationOptions: string | null;
    }
  | {
      readonly productId: string;
      readonly quantityScaled: string;
      readonly preparationNote: string | null;
      readonly preparationOptions: string | null;
    };

export interface RestaurantOrderReplaceLinesRequest {
  readonly operationId: string;
  readonly expectedRevision: string;
  readonly lines: readonly RestaurantOrderReplaceLine[];
}

export interface ProductSummary {
  readonly id: string;
  /** Optional only so pre-upgrade durable catalogue rows remain readable. */
  readonly categoryId?: string | null;
  readonly categoryNameAr?: string | null;
  readonly categorySortOrder?: number | null;
  readonly imageUrl?: string | null;
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

export type ProductMigrationTargetField =
  | 'sku'
  | 'barcode'
  | 'nameAr'
  | 'nameEn'
  | 'categoryNameAr'
  | 'productType'
  | 'unitLabel'
  | 'sellingPrice'
  | 'vatRate';

export type MigrationImportCell =
  | { readonly kind: 'blank' }
  | { readonly kind: 'text'; readonly value: string; readonly formulaLike: boolean }
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | {
      readonly kind: 'formula';
      readonly expression: string;
      readonly cachedValue: string | null;
    };

export interface ProductMigrationMapping {
  readonly sourceColumn: number;
  readonly targetField: ProductMigrationTargetField | null;
}

export interface ProductMigrationMappingSuggestion extends ProductMigrationMapping {
  readonly sourceHeader: string;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface MigrationImportIssue {
  readonly classification: 'WARNING' | 'ERROR' | 'BLOCKED';
  readonly code: string;
  readonly message: string;
  readonly row: number | null;
  readonly sourceColumn: number | null;
  readonly targetField: string | null;
}

export interface ProductMigrationInspection {
  readonly sourceSha256: string;
  readonly fileBytes: number;
  readonly totalRows: number;
  readonly header: readonly ProductMigrationMappingSuggestion[];
  readonly mappingIssues: readonly MigrationImportIssue[];
  readonly previewRows: readonly {
    readonly sourceRow: number;
    readonly cells: readonly MigrationImportCell[];
  }[];
}

export interface ProductMigrationRowResult {
  readonly sourceRow: number;
  readonly sourceIdentifier: string | null;
  readonly classification: 'VALID' | 'WARNING' | 'ERROR' | 'BLOCKED';
  readonly plannedAction: 'create' | 'reject';
  readonly status: 'pending' | 'committing' | 'rejected' | 'committed' | 'failed';
  readonly targetEntityId: string | null;
  readonly errorCode: string | null;
  readonly issues: readonly MigrationImportIssue[];
}

export interface ProductMigrationRowPage {
  readonly rows: readonly ProductMigrationRowResult[];
  readonly nextAfterSourceRow: number | null;
}

export interface ProductMigrationSummary {
  readonly id: string;
  readonly domain: 'products';
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceSha256: string;
  readonly status: 'reviewed' | 'dry-run' | 'committing' | 'completed';
  readonly mappingVersion: number;
  readonly mapping: readonly ProductMigrationMapping[];
  readonly conflictPolicy: 'reject';
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
  readonly created: number;
  readonly failed: number;
  readonly rejected: number;
  readonly rows: readonly ProductMigrationRowResult[];
  readonly rowsTruncated: boolean;
  readonly createdAt: string;
  readonly dryRunAt: string | null;
  readonly commitAt: string | null;
}

export interface CsvProductMigrationSource {
  readonly csvText: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
  readonly delimiter: ',' | ';' | '\t';
}

export interface XlsxProductMigrationSource {
  readonly xlsxBase64: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
}

export interface CreateCsvProductMigrationJobRequest extends CsvProductMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly ProductMigrationMapping[];
}

export interface CreateXlsxProductMigrationJobRequest extends XlsxProductMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly ProductMigrationMapping[];
}

export type CategoryMigrationTargetField = 'nameAr' | 'nameEn' | 'sortOrder';

export interface CategoryMigrationMapping {
  readonly sourceColumn: number;
  readonly targetField: CategoryMigrationTargetField | null;
}

export interface CategoryMigrationMappingSuggestion extends CategoryMigrationMapping {
  readonly sourceHeader: string;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface CategoryMigrationInspection {
  readonly sourceSha256: string;
  readonly fileBytes: number;
  readonly totalRows: number;
  readonly header: readonly CategoryMigrationMappingSuggestion[];
  readonly mappingIssues: readonly MigrationImportIssue[];
  readonly previewRows: readonly {
    readonly sourceRow: number;
    readonly cells: readonly MigrationImportCell[];
  }[];
}

export interface CategoryMigrationRowResult {
  readonly sourceRow: number;
  readonly sourceIdentifier: string | null;
  readonly classification: 'VALID' | 'WARNING' | 'ERROR' | 'BLOCKED';
  readonly plannedAction: 'create' | 'reject';
  readonly status: 'pending' | 'committing' | 'rejected' | 'committed' | 'failed';
  readonly targetEntityId: string | null;
  readonly errorCode: string | null;
  readonly issues: readonly MigrationImportIssue[];
}

export interface CategoryMigrationRowPage {
  readonly rows: readonly CategoryMigrationRowResult[];
  readonly nextAfterSourceRow: number | null;
}

export interface CategoryMigrationSummary {
  readonly id: string;
  readonly domain: 'categories';
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceSha256: string;
  readonly status: 'reviewed' | 'dry-run' | 'committing' | 'completed';
  readonly mappingVersion: number;
  readonly mapping: readonly CategoryMigrationMapping[];
  readonly conflictPolicy: 'reject';
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
  readonly created: number;
  readonly failed: number;
  readonly rejected: number;
  readonly rows: readonly CategoryMigrationRowResult[];
  readonly rowsTruncated: boolean;
  readonly createdAt: string;
  readonly dryRunAt: string | null;
  readonly commitAt: string | null;
}

export interface CsvCategoryMigrationSource {
  readonly csvText: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
  readonly delimiter: ',' | ';' | '\t';
}

export interface XlsxCategoryMigrationSource {
  readonly xlsxBase64: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
}

export interface CreateCsvCategoryMigrationJobRequest extends CsvCategoryMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly CategoryMigrationMapping[];
}

export interface CreateXlsxCategoryMigrationJobRequest extends XlsxCategoryMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly CategoryMigrationMapping[];
}

export type CustomerMigrationTargetField = 'nameAr' | 'nameEn' | 'phone' | 'email' | 'vatNumber';
export type CustomerMigrationConflictPolicy = 'reject' | 'update-existing-by-phone';

export interface CustomerMigrationMapping {
  readonly sourceColumn: number;
  readonly targetField: CustomerMigrationTargetField | null;
}

export interface CustomerMigrationMappingSuggestion extends CustomerMigrationMapping {
  readonly sourceHeader: string;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface CustomerMigrationInspection {
  readonly sourceSha256: string;
  readonly fileBytes: number;
  readonly totalRows: number;
  readonly header: readonly CustomerMigrationMappingSuggestion[];
  readonly mappingIssues: readonly MigrationImportIssue[];
  readonly previewRows: readonly {
    readonly sourceRow: number;
    readonly cells: readonly MigrationImportCell[];
  }[];
}

export interface CustomerMigrationRowResult {
  readonly sourceRow: number;
  readonly sourceIdentifier: string | null;
  readonly classification: 'VALID' | 'WARNING' | 'ERROR' | 'BLOCKED';
  readonly plannedAction: 'create' | 'update' | 'reject';
  readonly status: 'pending' | 'committing' | 'rejected' | 'committed' | 'failed';
  readonly targetEntityId: string | null;
  readonly errorCode: string | null;
  readonly issues: readonly MigrationImportIssue[];
}

export interface CustomerMigrationRowPage {
  readonly rows: readonly CustomerMigrationRowResult[];
  readonly nextAfterSourceRow: number | null;
}

export interface CustomerMigrationSummary {
  readonly id: string;
  readonly domain: 'customers';
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceSha256: string;
  readonly status: 'reviewed' | 'dry-run' | 'committing' | 'completed';
  readonly mappingVersion: number;
  readonly mapping: readonly CustomerMigrationMapping[];
  readonly conflictPolicy: CustomerMigrationConflictPolicy;
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
  readonly created: number;
  readonly updated: number;
  readonly failed: number;
  readonly rejected: number;
  readonly rows: readonly CustomerMigrationRowResult[];
  readonly rowsTruncated: boolean;
  readonly createdAt: string;
  readonly dryRunAt: string | null;
  readonly commitAt: string | null;
}

export interface CsvCustomerMigrationSource {
  readonly csvText: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
  readonly delimiter: ',' | ';' | '\t';
}

export interface XlsxCustomerMigrationSource {
  readonly xlsxBase64: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
}

export interface CreateCsvCustomerMigrationJobRequest extends CsvCustomerMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly CustomerMigrationMapping[];
  readonly conflictPolicy?: CustomerMigrationConflictPolicy;
}

export interface CreateXlsxCustomerMigrationJobRequest extends XlsxCustomerMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly CustomerMigrationMapping[];
  readonly conflictPolicy?: CustomerMigrationConflictPolicy;
}

export type SupplierMigrationTargetField = 'name';

export interface SupplierMigrationMapping {
  readonly sourceColumn: number;
  readonly targetField: SupplierMigrationTargetField | null;
}

export interface SupplierMigrationMappingSuggestion extends SupplierMigrationMapping {
  readonly sourceHeader: string;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface SupplierMigrationInspection {
  readonly sourceSha256: string;
  readonly fileBytes: number;
  readonly totalRows: number;
  readonly header: readonly SupplierMigrationMappingSuggestion[];
  readonly mappingIssues: readonly MigrationImportIssue[];
  readonly previewRows: readonly {
    readonly sourceRow: number;
    readonly cells: readonly MigrationImportCell[];
  }[];
}

export interface SupplierMigrationRowResult {
  readonly sourceRow: number;
  readonly sourceIdentifier: string | null;
  readonly classification: 'VALID' | 'WARNING' | 'ERROR' | 'BLOCKED';
  readonly plannedAction: 'create' | 'reject';
  readonly status: 'pending' | 'committing' | 'rejected' | 'committed' | 'failed';
  readonly targetEntityId: string | null;
  readonly errorCode: string | null;
  readonly issues: readonly MigrationImportIssue[];
}

export interface SupplierMigrationRowPage {
  readonly rows: readonly SupplierMigrationRowResult[];
  readonly nextAfterSourceRow: number | null;
}

export interface SupplierMigrationSummary {
  readonly id: string;
  readonly domain: 'suppliers';
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceSha256: string;
  readonly status: 'reviewed' | 'dry-run' | 'committing' | 'completed';
  readonly mappingVersion: number;
  readonly mapping: readonly SupplierMigrationMapping[];
  readonly conflictPolicy: 'reject';
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
  readonly created: number;
  readonly failed: number;
  readonly rejected: number;
  readonly rows: readonly SupplierMigrationRowResult[];
  readonly rowsTruncated: boolean;
  readonly createdAt: string;
  readonly dryRunAt: string | null;
  readonly commitAt: string | null;
}

export interface CsvSupplierMigrationSource {
  readonly csvText: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
  readonly delimiter: ',' | ';' | '\t';
}

export interface XlsxSupplierMigrationSource {
  readonly xlsxBase64: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
}

export interface CreateCsvSupplierMigrationJobRequest extends CsvSupplierMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly SupplierMigrationMapping[];
}

export interface CreateXlsxSupplierMigrationJobRequest extends XlsxSupplierMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly SupplierMigrationMapping[];
}

export type OpeningInventoryMigrationTargetField = 'branchCode' | 'sku' | 'openingQuantity';

export interface OpeningInventoryMigrationMapping {
  readonly sourceColumn: number;
  readonly targetField: OpeningInventoryMigrationTargetField | null;
}

export interface OpeningInventoryMigrationMappingSuggestion extends OpeningInventoryMigrationMapping {
  readonly sourceHeader: string;
  readonly reason: 'exact-alias' | 'unmapped';
}

export interface OpeningInventoryMigrationInspection {
  readonly sourceSha256: string;
  readonly fileBytes: number;
  readonly totalRows: number;
  readonly header: readonly OpeningInventoryMigrationMappingSuggestion[];
  readonly mappingIssues: readonly MigrationImportIssue[];
  readonly previewRows: readonly {
    readonly sourceRow: number;
    readonly cells: readonly MigrationImportCell[];
  }[];
}

export interface OpeningInventoryMigrationRowResult {
  readonly sourceRow: number;
  readonly sourceIdentifier: string | null;
  readonly classification: 'VALID' | 'WARNING' | 'ERROR' | 'BLOCKED';
  readonly plannedAction: 'create' | 'reject';
  readonly status: 'pending' | 'committing' | 'rejected' | 'committed' | 'failed';
  readonly targetEntityId: string | null;
  readonly errorCode: string | null;
  readonly issues: readonly MigrationImportIssue[];
}

export interface OpeningInventoryMigrationRowPage {
  readonly rows: readonly OpeningInventoryMigrationRowResult[];
  readonly nextAfterSourceRow: number | null;
}

export interface OpeningInventoryMigrationSummary {
  readonly id: string;
  readonly domain: 'opening-inventory';
  readonly format: 'csv' | 'xlsx';
  readonly sourceFileName: string | null;
  readonly sourceSystem: string | null;
  readonly sourceSha256: string;
  readonly status: 'reviewed' | 'dry-run' | 'committing' | 'completed';
  readonly mappingVersion: number;
  readonly mapping: readonly OpeningInventoryMigrationMapping[];
  readonly conflictPolicy: 'reject';
  readonly totalRows: number;
  readonly validRows: number;
  readonly warningRows: number;
  readonly errorRows: number;
  readonly blockedRows: number;
  readonly created: number;
  readonly failed: number;
  readonly rejected: number;
  readonly rows: readonly OpeningInventoryMigrationRowResult[];
  readonly rowsTruncated: boolean;
  readonly createdAt: string;
  readonly dryRunAt: string | null;
  readonly commitAt: string | null;
}

export interface CsvOpeningInventoryMigrationSource {
  readonly csvText: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
  readonly delimiter: ',' | ';' | '\t';
}

export interface XlsxOpeningInventoryMigrationSource {
  readonly xlsxBase64: string;
  readonly fileName: string | null;
  readonly sourceSystem: string | null;
}

export interface CreateCsvOpeningInventoryMigrationJobRequest extends CsvOpeningInventoryMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly OpeningInventoryMigrationMapping[];
}

export interface CreateXlsxOpeningInventoryMigrationJobRequest extends XlsxOpeningInventoryMigrationSource {
  readonly operationId: string;
  readonly mapping: readonly OpeningInventoryMigrationMapping[];
}

export type OnboardingCheckKey =
  | 'tenant-active'
  | 'settings-present'
  | 'active-branch'
  | 'active-terminal'
  | 'viable-administrator'
  | 'pos-operator'
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
  /** Optional for backward-compatible local fixtures; live responses carry null or a recorded value. */
  readonly orderType?: RestaurantOrderType | null;
  /** Operational dine-in context only; never fiscal receipt content. */
  readonly tableId?: string | null;
  /** Present when this sale atomically settled an open restaurant order. */
  readonly restaurantOrderId?: string | null;
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

/**
 * Fiscal receipt evidence is server-authored from the durable sealed artifact.
 * The client may render/print it, but must never manufacture or mutate it.
 */
export interface FiscalReceipt {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly issuedAt: string;
  readonly currency: string;
  readonly sellerName: string;
  readonly vatRegistrationNumber: string;
  readonly lines: readonly {
    readonly lineNumber: number;
    readonly description: string;
    readonly quantityScaled: string;
    readonly totalMinor: string;
  }[];
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly invoiceHashBase64: string;
  readonly qrCodeBase64: string;
  readonly fiscalizationMode: 'production' | 'simulation';
  readonly disclaimer: string | null;
}

export interface CheckoutResponse {
  readonly sale: SaleSummary;
  readonly receipt: FiscalReceipt;
  readonly replayed: boolean;
}

/** Exactly what a checkout may assert. Anything else is the server's business. */
export interface CheckoutRequest {
  readonly operationId: string;
  readonly terminalId: string;
  /** Delayed/offline replay precondition. The server derives the active shift and only compares. */
  readonly expectedShiftId?: string;
  readonly orderType?: RestaurantOrderType;
  readonly tableId?: string;
  readonly restaurantOrderId?: string;
  readonly expectedRestaurantOrderRevision?: string;
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
  readonly isActive: boolean;
  readonly trackInventory: boolean;
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

/** Current valuation facts; no average/unit-cost figure is derived here. */
export interface InventoryCostBalanceRow {
  readonly branchId: string;
  readonly productId: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string;
  readonly isActive: boolean;
  readonly trackInventory: boolean;
  readonly quantityScaled: string;
  readonly knownQuantityScaled: string;
  readonly unknownPositiveQuantityScaled: string;
  readonly knownValueMinor: string;
  readonly stockRevision: string;
  readonly costRevision: string;
}

export interface InventoryCostBalancePage {
  readonly rows: readonly InventoryCostBalanceRow[];
  readonly nextCursor: string | null;
}

export interface InventoryCostBootstrapRequest {
  readonly operationId: string;
  readonly branchId: string;
  readonly productId: string;
  /** Exact total value for the server-derived unknown positive quantity. */
  readonly totalValueMinor: string;
  /** Frozen observations; the server compares them under lock before deriving the result. */
  readonly expectedStockRevision: string;
  readonly expectedCostRevision: string;
  readonly expectedUnknownPositiveQuantityScaled: string;
}

export interface InventoryCostBootstrapResult {
  readonly id: string;
  readonly branchId: string;
  readonly productId: string;
  readonly valuedQuantityScaled: string;
  readonly stockRevision: string;
  readonly costRevision: string;
  readonly occurredAt: string;
  readonly replayed: boolean;
}

export interface InventoryAdjustmentRequest {
  readonly operationId: string;
  readonly branchId: string;
  readonly reason: string;
  readonly lines: readonly {
    readonly productId: string;
    readonly deltaQuantityScaled: string;
  }[];
}

export interface InventoryCountRequest {
  readonly operationId: string;
  readonly branchId: string;
  readonly reason: string | null;
  readonly lines: readonly {
    readonly productId: string;
    readonly countedQuantityScaled: string;
    readonly expectedRevision: string;
  }[];
}

export interface InventoryTransferRequest {
  readonly operationId: string;
  readonly fromBranchId: string;
  readonly toBranchId: string;
  readonly reason: string | null;
  readonly lines: readonly {
    readonly productId: string;
    readonly quantityScaled: string;
  }[];
}

export interface InventoryStockLineResult {
  readonly productId: string;
  readonly beforeQuantityScaled: string;
  readonly afterQuantityScaled: string;
  readonly deltaQuantityScaled: string;
  readonly resultRevision: string;
}

export interface InventoryAdjustmentResult {
  readonly id: string;
  readonly branchId: string;
  readonly occurredAt: string;
  readonly replayed: boolean;
  readonly lines: readonly InventoryStockLineResult[];
}

export interface InventoryCountLineResult extends InventoryStockLineResult {
  readonly countedQuantityScaled: string;
  readonly expectedRevision: string;
}

export interface InventoryCountResult {
  readonly id: string;
  readonly branchId: string;
  readonly occurredAt: string;
  readonly replayed: boolean;
  readonly lines: readonly InventoryCountLineResult[];
}

export interface InventoryTransferLineResult {
  readonly productId: string;
  readonly quantityScaled: string;
  readonly sourceBeforeQuantityScaled: string;
  readonly sourceAfterQuantityScaled: string;
  readonly destinationBeforeQuantityScaled: string;
  readonly destinationAfterQuantityScaled: string;
  readonly sourceResultRevision: string;
  readonly destinationResultRevision: string;
}

export interface InventoryTransferResult {
  readonly id: string;
  readonly fromBranchId: string;
  readonly toBranchId: string;
  readonly occurredAt: string;
  readonly replayed: boolean;
  readonly lines: readonly InventoryTransferLineResult[];
}

export interface PurchasingBranch {
  readonly id: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly isActive: boolean;
}

export interface PurchasingProduct {
  readonly id: string;
  readonly sku: string;
  readonly nameAr: string;
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string;
  readonly isActive: boolean;
  readonly trackInventory: boolean;
}

export interface PurchasingSupplier {
  readonly id: string;
  readonly name: string;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PurchasingPage<T> {
  readonly rows: readonly T[];
  readonly nextCursor: string | null;
}

export type PurchaseOrderStatus = 'open' | 'partially_received' | 'received';

export interface PurchaseOrderLine {
  readonly id: string;
  readonly productId: string;
  readonly orderedQuantityScaled: string;
  readonly receivedQuantityScaled: string;
  readonly remainingQuantityScaled: string;
}

export interface PurchaseOrder {
  readonly id: string;
  readonly supplierId: string;
  readonly branchId: string;
  readonly reference: string | null;
  readonly status: PurchaseOrderStatus;
  readonly orderedAt: string;
  readonly lines: readonly PurchaseOrderLine[];
}

export interface PurchaseOrderSummary {
  readonly id: string;
  readonly supplierId: string;
  readonly branchId: string;
  readonly reference: string | null;
  readonly status: PurchaseOrderStatus;
  readonly orderedAt: string;
  readonly lineCount: number;
}

export interface SupplierCreateRequest {
  readonly operationId: string;
  readonly name: string;
}

export interface SupplierUpdateRequest {
  readonly operationId: string;
  readonly supplierId: string;
  readonly name?: string;
  readonly isActive?: boolean;
}

export interface SupplierMutationResult {
  readonly supplier: PurchasingSupplier;
  readonly replayed: boolean;
}

export interface PurchaseOrderCreateRequest {
  readonly operationId: string;
  readonly supplierId: string;
  readonly branchId: string;
  readonly reference: string | null;
  readonly lines: readonly {
    readonly productId: string;
    readonly orderedQuantityScaled: string;
  }[];
}

export interface PurchaseOrderCreateResult {
  readonly order: PurchaseOrder;
  readonly replayed: boolean;
}

export interface PurchaseReceiptCreateRequest {
  readonly operationId: string;
  readonly purchaseOrderId: string;
  readonly reference: string | null;
  readonly lines: readonly {
    readonly purchaseOrderLineId: string;
    readonly acceptedQuantityScaled: string;
    /** Omission is unknown cost; present zero is known zero-value acquisition. */
    readonly inventoryValueMinor?: string;
  }[];
}

export interface PurchaseReceiptLineResult {
  readonly id: string;
  readonly purchaseOrderLineId: string;
  readonly productId: string;
  readonly acceptedQuantityScaled: string;
  readonly orderedQuantityScaled: string;
  readonly beforeReceivedQuantityScaled: string;
  readonly afterReceivedQuantityScaled: string;
  readonly beforeQuantityScaled: string;
  readonly afterQuantityScaled: string;
  readonly resultRevision: string;
}

export interface PurchaseReceiptResult {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly branchId: string;
  readonly supplierId: string;
  readonly reference: string | null;
  readonly purchaseOrderStatus: PurchaseOrderStatus;
  readonly receivedAt: string;
  readonly replayed: boolean;
  readonly lines: readonly PurchaseReceiptLineResult[];
}

export interface PurchaseReceiptSummary {
  readonly id: string;
  readonly purchaseOrderId: string;
  readonly branchId: string;
  readonly supplierId: string;
  readonly reference: string | null;
  readonly receivedAt: string;
  readonly lines: readonly PurchaseReceiptLineResult[];
}

export interface AdminTerminal {
  readonly id: string;
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
  readonly isActive: boolean;
  readonly lastSeenAt: string | null;
}

/**
 * Merchant member DTO. This mirrors the value returned by the merchant-admin
 * API/database authority; it is not the platform control-plane user shape.
 */
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

export interface AdminProduct extends ProductSummary {
  readonly nameEn: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string;
  readonly trackInventory: boolean;
  readonly isActive: boolean;
  readonly createdAt: string;
}

export interface AdminCustomer {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
}

export interface AdminSupplier {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly vatNumber: string | null;
  readonly isActive: boolean;
  readonly createdAt: string;
}

export interface PlatformTenantSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string;
  readonly vatNumber: string | null;
  readonly status: 'active' | 'suspended';
  readonly createdAt: string;
  readonly branchCount: number;
  readonly terminalCount: number;
  readonly userCount: number;
  readonly activeProductCount: number;
  readonly openShiftCount: number;
  readonly saleCount: number;
  readonly lastSaleAt: string | null;
  readonly bootstrap: PlatformTenantBootstrapReadiness;
}

export interface PlatformTenantBootstrapReadiness {
  readonly ready: boolean;
  readonly checks: readonly OnboardingReadinessCheck[];
}

export interface PlatformTenantDetail extends PlatformTenantSummary {
  readonly settings: AdminTenantSettings | null;
  readonly branches: readonly AdminBranch[];
  readonly terminals: readonly AdminTerminal[];
  readonly members: readonly AdminMember[];
  readonly recentSales: readonly {
    readonly saleId: string;
    readonly invoiceNumber: string;
    readonly totalMinor: string;
    readonly issuedAt: string;
  }[];
  readonly supportNotes: readonly PlatformSupportNote[];
}

export interface PlatformSupportNote {
  readonly id: string;
  readonly authorUserId: string;
  readonly authorDisplayName: string;
  readonly note: string;
  readonly createdAt: string;
}

export interface PlatformSupportNoteCreateInput {
  readonly note: string;
}

export interface PlatformOwnerBootstrapInput {
  readonly slug: string;
  readonly name: string;
  readonly legalName: string;
  readonly vatNumber?: string | null;
  readonly adminEmail: string;
  readonly adminPassword: string;
  readonly adminDisplayName: string;
}

export interface PlatformOperationalBootstrapInput {
  readonly operationId: string;
  readonly branchCode: string;
  readonly branchNameAr: string;
  readonly branchNameEn?: string | null;
  readonly terminalCode: string;
  readonly terminalLabel: string;
  readonly productSku: string;
  readonly productNameAr: string;
  readonly productNameEn?: string | null;
  readonly productType: 'unit' | 'weighted';
  readonly unitLabel: string;
  readonly priceMinor: string;
  readonly barcode?: string | null;
}

export interface PlatformOperationalBootstrapResult {
  readonly replayed: boolean;
  readonly branch: AdminBranch;
  readonly terminal: AdminTerminal;
  readonly product: AdminProductBootstrap;
}

export interface AdminUserCreateInput {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly branchId?: string | null;
  readonly roleIds?: readonly string[];
}

export interface AdminUserUpdateInput {
  readonly displayName?: string;
  readonly branchId?: string | null;
  readonly roleIds?: readonly string[];
}

export interface AdminUserPasswordResetInput {
  readonly password: string;
}

export interface AdminBranchCreateInput {
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn?: string | null;
}

export interface AdminTerminalCreateInput {
  readonly branchId: string;
  readonly code: string;
  readonly label: string;
}

export interface AdminTerminalUpdateInput {
  readonly label?: string;
  readonly isActive?: boolean;
}

export interface AdminProductUpdateInput {
  readonly nameAr?: string;
  readonly nameEn?: string | null;
  readonly unitLabel?: string;
  readonly priceMinor?: string;
  readonly barcode?: string | null;
  readonly isActive?: boolean;
}

export interface AdminCustomerCreateInput {
  readonly code: string;
  readonly name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly vatNumber?: string | null;
}

export interface AdminCustomerUpdateInput {
  readonly name?: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly vatNumber?: string | null;
  readonly isActive?: boolean;
}

export interface AdminSupplierCreateInput {
  readonly code: string;
  readonly name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly vatNumber?: string | null;
}

export interface AdminSupplierUpdateInput {
  readonly name?: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly vatNumber?: string | null;
  readonly isActive?: boolean;
}

export interface ReportSalesSummary {
  readonly from: string;
  readonly to: string;
  readonly saleCount: number;
  readonly netMinor: string;
  readonly vatMinor: string;
  readonly totalMinor: string;
  readonly currency: string;
}

export interface ReportTopProduct {
  readonly productId: string | null;
  readonly sku: string;
  readonly nameAr: string;
  readonly quantityScaled: string;
  readonly totalMinor: string;
}

export interface ReportShiftVariance {
  readonly shiftId: string;
  readonly terminalId: string;
  readonly userId: string;
  readonly status: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly expectedCashMinor: string;
  readonly closingCashMinor: string | null;
  readonly varianceMinor: string | null;
}

export interface ReportSalesSummaryResponse {
  readonly summary: ReportSalesSummary;
}

export interface ReportTopProductsResponse {
  readonly rows: readonly ReportTopProduct[];
}

export interface ReportShiftVarianceResponse {
  readonly rows: readonly ReportShiftVariance[];
}

export interface ZatcaOnboardingStatus {
  readonly tenantId: string;
  readonly status: 'not_started' | 'onboarding' | 'ready' | 'blocked';
  readonly simulation: boolean;
  readonly currentStage: string | null;
  readonly lastFailureCode: string | null;
  readonly lastFailureMessage: string | null;
  readonly updatedAt: string | null;
}
