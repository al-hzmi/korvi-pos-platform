import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { BranchesPanel } from '../control/branches-panel';
import {
  canOpenControlCentre,
  CONTROL_ENTRIES,
  ControlNav,
  firstAuthorizedSection,
} from '../control/control-nav';
import { ControlSurface, preserveCommandBeforeUnload } from '../control/control-app';
import { DashboardPanel } from '../control/dashboard-panel';
import { InventoryOperations } from '../control/inventory-operations';
import {
  BootstrapResult,
  costRefreshPending,
  CostBootstrapForm,
  InventoryCostPanelView,
} from '../control/inventory-cost-panel';
import {
  acquireInventoryCommandWorkspace,
  describeInventoryReadFailure,
  InventoryPanel,
  InventoryPanelView,
} from '../control/inventory-panel';
import { MembersPanel } from '../control/members-panel';
import { ProductsPanel } from '../control/products-panel';
import {
  OrderDetail,
  orderLineFieldLabel,
  PurchasingOperations,
  ReceiptLineEditor,
  resolveOrderLineProduct,
} from '../control/purchasing-operations';
import { PurchasingPanel } from '../control/purchasing-panel';
import { SettingsPanel } from '../control/settings-panel';
import { ProductPanel } from '../product-panel';
import { controlView } from '../../lib/control-view';
import { ApiError } from '../../lib/api';
import { LOGOUT_UNCONFIRMED, hasPermission } from '../../lib/session';
import type { ApiClient } from '../../lib/api';
import type { Principal, ProductSummary } from '../../lib/api-types';

/**
 * What these tests are actually defending.
 *
 * The dangerous failure of a control centre is not a crash — it is a screen
 * that looks finished. A navigation entry that opens nothing, a figure that
 * renders 0 while the request is still in flight, an empty catalogue message
 * shown before the catalogue was asked for: each of those is a lie told
 * confidently, and each is cheap to introduce by accident.
 *
 * These render the components through react-dom/server, which runs the render
 * pass and deliberately does not run effects. That is exactly the first paint
 * a merchant sees, and the moment where a placeholder would be visible.
 */

/** A client that is never called: effects do not run in a static render. */
const idleApi = {} as ApiClient;

const principalWith = (permissions: readonly string[]): Principal => ({
  user: { id: 'u-1', email: 'person@example.test', displayName: 'مستخدم' },
  tenant: { id: 't-1' },
  session: { id: 's-1' },
  roles: [],
  permissions,
  branchId: 'b-1',
});

const SOMEBODY = principalWith(['report.read']);

const MILK: ProductSummary = {
  id: 'p-milk',
  sku: 'MILK-1L',
  nameAr: 'حليب طازج',
  nameEn: null,
  productType: 'unit',
  unitLabel: null,
  priceMinor: '1150',
  vatBasisPoints: 1500,
  primaryBarcode: '6281000000001',
  trackInventory: true,
};

function surface(state: Parameters<typeof controlView>[0]): string {
  return renderToStaticMarkup(
    createElement(ControlSurface, {
      view: controlView(state),
      api: idleApi,
      onAuthenticated: () => undefined,
      onRetrySession: () => undefined,
      onSignOut: () => undefined,
    }),
  );
}

describe('control navigation', () => {
  it('raises both browser unload signals while a command is unresolved', () => {
    let prevented = false;
    const event = {
      preventDefault: () => {
        prevented = true;
      },
      returnValue: false,
    } as unknown as BeforeUnloadEvent;

    preserveCommandBeforeUnload(event);

    expect(prevented).toBe(true);
    expect(event.returnValue).toBe(true);
  });

  it('names every planned module of the product', () => {
    expect(CONTROL_ENTRIES.map((entry) => entry.label)).toEqual([
      'الرئيسية',
      'المبيعات',
      'المنتجات',
      'المخزون',
      'المشتريات',
      'العملاء',
      'الفروع والصناديق',
      'الموظفون والصلاحيات',
      'التقارير',
      'الإعدادات',
      'ZATCA',
    ]);
  });

  it('marks unbuilt modules unavailable rather than opening an empty page', () => {
    const markup = renderToStaticMarkup(
      createElement(ControlNav, {
        active: 'home',
        permissions: [
          'report.read',
          'product.read',
          'inventory.read',
          'purchasing.read',
          'settings.manage',
          'users.manage',
        ],
        onSelect: () => undefined,
      }),
    );
    const unbuilt = CONTROL_ENTRIES.filter((entry) => entry.section === null);

    expect(unbuilt.length).toBeGreaterThan(0);
    expect(markup.match(/disabled/g) ?? []).toHaveLength(unbuilt.length);
    expect(markup.match(/قريباً/g) ?? []).toHaveLength(unbuilt.length);
    for (const entry of unbuilt) {
      expect(markup).toContain(entry.label);
    }
  });

  it('marks built administration sections unauthorized without their permissions', () => {
    const markup = renderToStaticMarkup(
      createElement(ControlNav, { active: 'home', permissions: [], onSelect: () => undefined }),
    );
    expect(markup.match(/غير مصرح/g) ?? []).toHaveLength(7);
  });

  it('keeps users.manage separate from settings.manage in navigation', () => {
    const peopleOnly = renderToStaticMarkup(
      createElement(ControlNav, {
        active: 'home',
        permissions: ['users.manage'],
        onSelect: () => undefined,
      }),
    );
    expect(peopleOnly).toContain('الموظفون والصلاحيات');
    expect(peopleOnly.match(/غير مصرح/g) ?? []).toHaveLength(6);
  });

  it('marks exactly one section as the open one', () => {
    const markup = renderToStaticMarkup(
      createElement(ControlNav, {
        active: 'products',
        permissions: ['product.read', 'settings.manage', 'users.manage'],
        onSelect: () => undefined,
      }),
    );
    expect(markup.match(/aria-current="page"/g) ?? []).toHaveLength(1);
  });

  it('keeps an unresolved stock command mounted by locking other sections', () => {
    const markup = renderToStaticMarkup(
      createElement(ControlNav, {
        active: 'inventory',
        permissions: ['report.read', 'product.read', 'inventory.read'],
        locked: true,
        onSelect: () => undefined,
      }),
    );
    expect(markup.match(/عملية معلقة/g) ?? []).toHaveLength(2);
    expect(markup).toMatch(/aria-current="page"/);
  });
});

describe('control centre first paint', () => {
  it('shows no dashboard figure until the server has answered', () => {
    const markup = renderToStaticMarkup(createElement(DashboardPanel, { api: idleApi }));

    expect(markup).toContain('جارٍ تحميل المؤشرات');
    expect(markup).not.toContain('مبيعات آخر');
    expect(markup).not.toContain('عدد الفواتير');
    expect(markup).not.toContain('الأصناف المفعّلة');
  });

  it('does not claim an empty catalogue before the catalogue has loaded', () => {
    const markup = renderToStaticMarkup(createElement(ProductsPanel, { api: idleApi }));

    expect(markup).toContain('جارٍ التحميل');
    expect(markup).not.toContain('لا توجد أصناف مطابقة');
  });

  it('offers no way to edit a catalogue there is no write API for', () => {
    const markup = renderToStaticMarkup(createElement(ProductsPanel, { api: idleApi }));
    expect(markup).toContain('عرض فقط');
    expect(markup).not.toContain('حفظ');
  });

  it('does not claim settings are editable until their authority has loaded', () => {
    const markup = renderToStaticMarkup(createElement(SettingsPanel, { api: idleApi }));
    expect(markup).toContain('جارٍ تحميل إعدادات المنشأة');
    expect(markup).not.toContain('حفظ الإعدادات');
  });

  it('does not claim the merchant has no branches before the list is loaded', () => {
    const markup = renderToStaticMarkup(createElement(BranchesPanel, { api: idleApi }));
    expect(markup).toContain('جارٍ تحميل الفروع والصناديق');
    expect(markup).not.toContain('لا توجد فروع حتى الآن');
    expect(markup).not.toContain('لا توجد صناديق حتى الآن');
  });

  it('does not claim the merchant has no staff before members and roles load', () => {
    const markup = renderToStaticMarkup(
      createElement(MembersPanel, { api: idleApi, canManageSettings: false }),
    );
    expect(markup).toContain('جارٍ تحميل الموظفين والصلاحيات');
    expect(markup).not.toContain('لا يوجد موظفون في المنشأة حتى الآن');
    expect(markup).not.toContain('إضافة الموظف');
  });

  it('does not claim an empty stock ledger before branches have loaded', () => {
    const markup = renderToStaticMarkup(
      createElement(InventoryPanel, {
        api: idleApi,
        preferredBranchId: 'b-1',
        permissions: ['inventory.read'],
      }),
    );
    expect(markup).toContain('جارٍ تحميل فروع المخزون');
    expect(markup).not.toContain('لا توجد فروع');
    expect(markup).not.toContain('لا توجد أرصدة');
  });

  it('does not claim empty purchasing data before all bounded reads answer', () => {
    const markup = renderToStaticMarkup(
      createElement(PurchasingPanel, {
        api: idleApi,
        permissions: ['purchasing.read'],
      }),
    );
    expect(markup).toContain('جارٍ تحميل الموردين وأوامر الشراء');
    expect(markup).not.toContain('لا توجد أوامر شراء');
    expect(markup).not.toContain('إضافة مورد');
  });
});

describe('who the control centre is for', () => {
  it('admits an operational role without granting it the dashboard', () => {
    const cashier = principalWith(ROLE_PERMISSIONS.cashier);
    expect(hasPermission(cashier, 'report.read')).toBe(false);
    expect(canOpenControlCentre(cashier.permissions)).toBe(true);
    expect(firstAuthorizedSection(cashier.permissions)).toBe('products');
    expect(firstAuthorizedSection(['inventory.read'])).toBe('inventory');
    expect(firstAuthorizedSection(['purchasing.read'])).toBe('purchasing');

    const inventoryOnly = surface({ kind: 'ready', principal: principalWith(['inventory.read']) });
    expect(inventoryOnly).toContain('جارٍ تحميل فروع المخزون');
    expect(inventoryOnly).not.toContain('جارٍ تحميل المؤشرات');

    const purchasingOnly = surface({
      kind: 'ready',
      principal: principalWith(['purchasing.read']),
    });
    expect(purchasingOnly).toContain('جارٍ تحميل الموردين وأوامر الشراء');
    expect(purchasingOnly).not.toContain('جارٍ تحميل المؤشرات');
  });

  it('keeps the control centre blocked when no built section is authorized', () => {
    expect(canOpenControlCentre([])).toBe(false);
    const markup = surface({ kind: 'ready', principal: principalWith([]) });
    expect(markup).toContain('لا تملك صلاحية الاطلاع على لوحة التحكم');
    expect(markup).not.toContain('جارٍ تحميل المؤشرات');
    expect(markup).not.toContain('جارٍ تحميل فروع المخزون');
  });

  it('does not confuse dashboard access with merchant administration', () => {
    expect(ROLE_PERMISSIONS.manager).toContain('report.read');
    expect(ROLE_PERMISSIONS.manager).not.toContain('settings.manage');
    expect(ROLE_PERMISSIONS.manager).not.toContain('users.manage');
    expect(ROLE_PERMISSIONS.admin).toContain('settings.manage');
    expect(ROLE_PERMISSIONS.admin).toContain('users.manage');
    expect(ROLE_PERMISSIONS.owner).toContain('settings.manage');
    expect(ROLE_PERMISSIONS.owner).toContain('users.manage');
  });

  it('is the same permission the server dashboard route demands', () => {
    expect(ROLE_PERMISSIONS.cashier).not.toContain('report.read');
  });
});

describe('inventory balance presentation', () => {
  const branchId = '018fb000-0000-7000-8000-0000000000a1';
  const branches = {
    kind: 'ready',
    page: {
      rows: [
        {
          id: branchId,
          code: 'MAIN-1',
          nameAr: 'الفرع الرئيسي',
          nameEn: 'Main',
          isActive: true,
        },
      ],
      nextCursor: null,
    },
    loadingMore: false,
    loadFailure: null,
  } as const;
  const handlers = {
    onSelectBranch: () => undefined,
    onRetryBranches: () => undefined,
    onLoadMoreBranches: () => undefined,
    onRetryBalances: () => undefined,
    onLoadMoreBalances: () => undefined,
  } as const;

  it('claims the stock/cost command workspace synchronously across sibling forms', () => {
    const lock = { current: false };
    expect(acquireInventoryCommandWorkspace(lock)).toBe(true);
    expect(acquireInventoryCommandWorkspace(lock)).toBe(false);
    lock.current = false;
    expect(acquireInventoryCommandWorkspace(lock)).toBe(true);
  });

  it('does not reuse cashier-cart wording for an inventory read failure', () => {
    const failure = describeInventoryReadFailure(new ApiError(0, 'network', null));
    expect(failure.message).toContain('بيانات المخزون');
    expect(failure.message).not.toContain('السلة');
    expect(failure.action).toBe('retry-same');
  });

  it('renders server product identity and exact scaled quantities with bidi isolation', () => {
    const markup = renderToStaticMarkup(
      createElement(InventoryPanelView, {
        ...handlers,
        branches,
        selectedBranchId: branchId,
        balances: {
          kind: 'ready',
          branchId,
          page: {
            rows: [
              {
                branchId,
                productId: '018fb000-0000-7000-8000-0000000000a5',
                sku: 'MILK-1L',
                nameAr: 'حليب طازج',
                nameEn: 'Fresh Milk',
                productType: 'unit',
                unitLabel: 'each',
                isActive: true,
                trackInventory: true,
                quantityScaled: '1250',
                revision: '9007199254740993',
              },
            ],
            nextCursor: null,
          },
          loadingMore: false,
          refreshing: false,
          generation: 1,
          loadFailure: null,
        },
      }),
    );

    expect(markup).toContain('حليب طازج');
    expect(markup).toContain('MILK-1L');
    expect(markup).toContain('1.25');
    expect(markup).toContain('9007199254740993');
    expect(markup.match(/dir="ltr"/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(markup).toContain('h-touch');
  });

  it('shows only stock commands granted by the session permissions', () => {
    const branch = branches.page.rows[0]!;
    const row = {
      branchId,
      productId: '018fb000-0000-7000-8000-0000000000a5',
      sku: 'MILK-1L',
      nameAr: 'حليب طازج',
      nameEn: 'Fresh Milk',
      productType: 'unit',
      unitLabel: 'each',
      isActive: true,
      trackInventory: true,
      quantityScaled: '1250',
      revision: '9',
    } as const;

    const adjustment = renderToStaticMarkup(
      createElement(InventoryOperations, {
        api: idleApi,
        branch,
        branches: branches.page.rows,
        balances: [row],
        refreshing: false,
        balanceGeneration: 1,
        permissions: ['inventory.adjust'],
        onRefreshBalances: () => undefined,
        onCommandLockAcquire: () => true,
        onCommandLockChange: () => undefined,
      }),
    );
    expect(adjustment).toContain('تسوية زيادة أو نقص');
    expect(adjustment).toContain('جرد فعلي');
    expect(adjustment).not.toContain('تحويل إلى فرع');
    expect(adjustment).toContain('الخادم');
    expect(adjustment).toContain('\u2066MILK-1L\u2069');

    const transfer = renderToStaticMarkup(
      createElement(InventoryOperations, {
        api: idleApi,
        branch,
        branches: [
          branch,
          { ...branch, id: '018fb000-0000-7000-8000-0000000000a2', nameAr: 'فرع ثانٍ' },
        ],
        balances: [row],
        refreshing: false,
        balanceGeneration: 1,
        permissions: ['inventory.transfer'],
        onRefreshBalances: () => undefined,
        onCommandLockAcquire: () => true,
        onCommandLockChange: () => undefined,
      }),
    );
    expect(transfer).toContain('تحويل إلى فرع');
    expect(transfer).not.toContain('تسوية زيادة أو نقص');
    expect(transfer).not.toContain('جرد فعلي');

    const readOnly = renderToStaticMarkup(
      createElement(InventoryOperations, {
        api: idleApi,
        branch,
        branches: branches.page.rows,
        balances: [row],
        refreshing: false,
        balanceGeneration: 1,
        permissions: ['inventory.read'],
        onRefreshBalances: () => undefined,
        onCommandLockAcquire: () => true,
        onCommandLockChange: () => undefined,
      }),
    );
    expect(readOnly).toBe('');
  });

  it('keeps historical branches read-only and locks commands during a balance refresh', () => {
    const branch = branches.page.rows[0]!;
    const row = {
      branchId,
      productId: '018fb000-0000-7000-8000-0000000000a5',
      sku: 'MILK-1L',
      nameAr: 'حليب',
      nameEn: null,
      productType: 'unit',
      unitLabel: 'each',
      isActive: true,
      trackInventory: true,
      quantityScaled: '1000',
      revision: '1',
    } as const;

    const historical = renderToStaticMarkup(
      createElement(InventoryOperations, {
        api: idleApi,
        branch: { ...branch, isActive: false },
        branches: branches.page.rows,
        balances: [row],
        refreshing: false,
        balanceGeneration: 1,
        permissions: ['inventory.adjust', 'inventory.transfer'],
        onRefreshBalances: () => undefined,
        onCommandLockAcquire: () => true,
        onCommandLockChange: () => undefined,
      }),
    );
    expect(historical).toContain('للقراءة التاريخية فقط');
    expect(historical).not.toContain('<form');

    const refreshing = renderToStaticMarkup(
      createElement(InventoryOperations, {
        api: idleApi,
        branch,
        branches: branches.page.rows,
        balances: [row],
        refreshing: true,
        balanceGeneration: 1,
        permissions: ['inventory.adjust'],
        onRefreshBalances: () => undefined,
        onCommandLockAcquire: () => true,
        onCommandLockChange: () => undefined,
      }),
    );
    expect(refreshing).toContain('انتظر اكتمال تحديث الرصيد');
    expect(refreshing).toContain('<fieldset class="grid gap-3 md:grid-cols-3" disabled=""');
  });

  it('shows an empty balance only after a selected branch answered', () => {
    const markup = renderToStaticMarkup(
      createElement(InventoryPanelView, {
        ...handlers,
        branches,
        selectedBranchId: branchId,
        balances: {
          kind: 'ready',
          branchId,
          page: { rows: [], nextCursor: null },
          loadingMore: false,
          refreshing: false,
          generation: 1,
          loadFailure: null,
        },
      }),
    );
    expect(markup).toContain('لا توجد أرصدة مخزون مسجلة');
    expect(markup).not.toContain('جارٍ تحميل أرصدة الفرع');
  });

  it('keeps read failures recoverable and disables a page action while loading', () => {
    const failed = renderToStaticMarkup(
      createElement(InventoryPanelView, {
        ...handlers,
        branches,
        selectedBranchId: branchId,
        balances: {
          kind: 'failed',
          branchId,
          failure: { code: 'network', message: 'تعذر الاتصال.', action: 'retry-same' },
        },
      }),
    );
    expect(failed).toContain('تعذر الاتصال');
    expect(failed).toContain('إعادة تحميل الأرصدة');

    const paging = renderToStaticMarkup(
      createElement(InventoryPanelView, {
        ...handlers,
        branches: {
          ...branches,
          page: { ...branches.page, nextCursor: branchId },
          loadingMore: true,
        },
        selectedBranchId: branchId,
        balances: { kind: 'loading', branchId },
      }),
    );
    expect(paging).toMatch(/disabled=""[^>]*aria-busy="true"|aria-busy="true"[^>]*disabled=""/);
  });
});

describe('inventory cost presentation', () => {
  it('requires the promised fresh generation before a second cost decision', () => {
    expect(costRefreshPending(8, 7)).toBe(true);
    expect(costRefreshPending(8, 8)).toBe(false);
    expect(costRefreshPending(null, 7)).toBe(false);
  });

  const branch = {
    id: '018fb000-0000-7000-8000-0000000000a1',
    code: 'MAIN',
    nameAr: 'الفرع الرئيسي',
    nameEn: 'Main',
    isActive: true,
  } as const;
  const row = {
    branchId: branch.id,
    productId: '018fb000-0000-7000-8000-0000000000a5',
    sku: 'MILK-1L',
    nameAr: 'حليب طازج',
    nameEn: 'Fresh Milk',
    productType: 'unit',
    unitLabel: 'حبة',
    isActive: true,
    trackInventory: true,
    quantityScaled: '9007199254740993000',
    knownQuantityScaled: '7000000000000000000',
    unknownPositiveQuantityScaled: '2007199254740993000',
    knownValueMinor: '900719925474099300',
    stockRevision: '12',
    costRevision: '8',
  } as const;
  const ready = {
    kind: 'ready',
    page: { rows: [row], nextCursor: null },
    loadingMore: false,
    refreshing: false,
    generation: 1,
    loadFailure: null,
  } as const;

  it('renders exact known/unknown facts without deriving a unit or average cost', () => {
    const markup = renderToStaticMarkup(
      createElement(InventoryCostPanelView, {
        state: ready,
        canManageCost: false,
        onRetry: () => undefined,
        onLoadMore: () => undefined,
      }),
    );
    expect(markup).toContain('حليب طازج');
    expect(markup).toContain('2007199254740993');
    expect(markup).toContain('9007199254740993.00');
    expect(markup).toContain('مختلطة');
    expect(markup).toContain('صلاحية قراءة التكلفة دون صلاحية إنشاء تقييم');
    expect(markup).not.toMatch(/متوسط التكلفة|تكلفة الوحدة/);
    expect(markup).toContain('لا تستنتج تكلفة من سعر البيع');
    expect(markup.match(/dir="ltr"/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
  });

  it('shows prospective bootstrap only when cost management is also granted', () => {
    const form = createElement(CostBootstrapForm, {
      api: idleApi,
      branch,
      rows: [row],
      refreshing: false,
      generation: 1,
      workspaceLocked: false,
      onRefresh: () => undefined,
      onCommandLockAcquire: () => true,
      onCommandLockChange: () => undefined,
    });
    const denied = renderToStaticMarkup(
      createElement(InventoryCostPanelView, {
        state: ready,
        canManageCost: false,
        onRetry: () => undefined,
        onLoadMore: () => undefined,
        bootstrap: form,
      }),
    );
    const allowed = renderToStaticMarkup(
      createElement(InventoryCostPanelView, {
        state: ready,
        canManageCost: true,
        onRetry: () => undefined,
        onLoadMore: () => undefined,
        bootstrap: form,
      }),
    );
    expect(denied).not.toContain('إجمالي قيمة اقتناء الكمية المجهولة');
    expect(allowed).toContain('إجمالي قيمة اقتناء الكمية المجهولة');
    expect(allowed).toContain('يطابق الخادم مراجعات المخزون والتكلفة');
    expect(allowed).toContain('يرفض القرار ويطلب قراءة جديدة');
    expect(allowed).toContain('h-touch');
    expect(allowed).toContain('\u2066MILK-1L\u2069');
  });

  it('keeps the valued product identity explicit after it leaves the eligible set', () => {
    const markup = renderToStaticMarkup(
      createElement(BootstrapResult, {
        product: row,
        result: {
          id: '018fb000-0000-7000-8000-0000000000c1',
          branchId: branch.id,
          productId: row.productId,
          valuedQuantityScaled: row.unknownPositiveQuantityScaled,
          stockRevision: row.stockRevision,
          costRevision: '9',
          occurredAt: '2026-08-31T00:00:00.000Z',
          replayed: false,
        },
      }),
    );

    expect(markup).toContain('حليب طازج');
    expect(markup).toContain('MILK-1L');
    expect(markup).toContain(row.productId);
    expect(markup).toContain('2007199254740993');
  });
});

describe('purchasing presentation', () => {
  const pages = {
    branches: {
      rows: [
        {
          id: 'branch-1',
          code: 'MAIN',
          nameAr: 'الفرع الرئيسي',
          nameEn: 'Main',
          isActive: true,
        },
      ],
      nextCursor: null,
    },
    products: {
      rows: [
        {
          id: 'product-1',
          sku: 'RICE-1',
          nameAr: 'أرز',
          nameEn: 'Rice',
          productType: 'weighted',
          unitLabel: 'كجم',
          isActive: true,
          trackInventory: true,
        },
      ],
      nextCursor: null,
    },
    suppliers: {
      rows: [
        {
          id: 'supplier-1',
          name: 'مورد الرياض',
          isActive: true,
          createdAt: '2026-08-31T00:00:00.000Z',
          updatedAt: '2026-08-31T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    },
    orders: {
      rows: [
        {
          id: 'order-1',
          supplierId: 'supplier-1',
          branchId: 'branch-1',
          reference: 'PO-1',
          status: 'partially_received',
          orderedAt: '2026-08-31T00:00:00.000Z',
          lineCount: 1,
        },
      ],
      nextCursor: null,
    },
  } as const;

  const common = {
    api: idleApi,
    pages,
    refreshing: false,
    loadingMore: null,
    onRefresh: () => Promise.resolve(true),
    onLoadMore: () => undefined,
    onCommandLockChange: () => undefined,
  } as const;

  it('resolves distinct visible defaults before adding another order line', () => {
    const products = [
      pages.products.rows[0],
      { ...pages.products.rows[0], id: 'product-2', sku: 'RICE-2' },
    ];

    expect(resolveOrderLineProduct(products, '', 0)?.id).toBe('product-1');
    expect(resolveOrderLineProduct(products, '', 1)?.id).toBe('product-2');
  });

  it('gives repeated order-line fields distinct accessible names', () => {
    expect(orderLineFieldLabel('product', 0)).toBe('الصنف في بند أمر الشراء 1');
    expect(orderLineFieldLabel('product', 1)).toBe('الصنف في بند أمر الشراء 2');
    expect(orderLineFieldLabel('quantity', 1)).toBe('الكمية المطلوبة في بند أمر الشراء 2');
  });

  it('renders receipt value input only for independent cost management authority', () => {
    const line = {
      id: 'line-1',
      productId: 'product-1',
      orderedQuantityScaled: '3000',
      receivedQuantityScaled: '1000',
      remainingQuantityScaled: '2000',
    } as const;
    const commonLine = {
      line,
      label: 'حليب — MILK-1L',
      quantity: '1',
      inventoryValue: { enabled: true, value: '0.00' },
      disabled: false,
      onQuantityChange: () => undefined,
      onCostEnabledChange: () => undefined,
      onCostValueChange: () => undefined,
    } as const;
    const receiver = renderToStaticMarkup(
      createElement(ReceiptLineEditor, { ...commonLine, canManageCost: false }),
    );
    const costManager = renderToStaticMarkup(
      createElement(ReceiptLineEditor, { ...commonLine, canManageCost: true }),
    );

    expect(receiver).toContain('الكمية المستلمة');
    expect(receiver).not.toContain('قيمة اقتناء');
    expect(costManager).toContain('إجمالي قيمة اقتناء الكمية المستلمة');
    expect(costManager).toContain('value="0.00"');
    expect(costManager).toContain('type="checkbox"');
    expect(costManager).toContain('aria-label="تسجيل قيمة اقتناء حليب — MILK-1L"');
    expect(costManager).toContain('h-touch');
  });

  it('shows supplier and order authoring only with purchasing.manage', () => {
    const manager = renderToStaticMarkup(
      createElement(PurchasingOperations, {
        ...common,
        permissions: ['purchasing.read', 'purchasing.manage'],
      }),
    );
    expect(manager).toContain('إضافة مورد');
    expect(manager).toContain('تعديل أو تعطيل مورد');
    expect(manager).toContain('أوامر الشراء');
    expect(manager.match(/aria-pressed="true"/g) ?? []).toHaveLength(1);
    expect(manager.match(/aria-pressed="false"/g) ?? []).toHaveLength(2);

    const reader = renderToStaticMarkup(
      createElement(PurchasingOperations, {
        ...common,
        permissions: ['purchasing.read'],
      }),
    );
    expect(reader).toContain('لديك صلاحية قراءة المشتريات دون إنشاء أوامر جديدة');
    expect(reader).not.toContain('إضافة مورد');
    expect(reader).not.toContain('إنشاء أمر الشراء');
  });

  it('renders server-derived order status and bounded identity without cost input', () => {
    const markup = renderToStaticMarkup(
      createElement(PurchasingOperations, {
        ...common,
        permissions: ['purchasing.read'],
      }),
    );
    expect(markup).toContain('مستلم جزئيًا');
    expect(markup).toContain('مورد الرياض');
    expect(markup).toContain('PO-1');
    expect(markup).not.toMatch(/قيمة المخزون|تكلفة الوحدة|inventoryValueMinor/);
    expect(markup).toContain('\u2066PO-1\u2069');
    expect(markup).toContain('aria-label="تفاصيل أمر الشراء 1، المرجع \u2066PO-1\u2069"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('h-touch');
  });

  it('keeps a failed order-detail read directly recoverable', () => {
    const markup = renderToStaticMarkup(
      createElement(OrderDetail, {
        state: { kind: 'failed', orderId: 'order-1', message: 'تعذر التحميل' },
        products: pages.products.rows,
        onRetry: () => undefined,
      }),
    );

    expect(markup).toContain('تعذر التحميل');
    expect(markup).toContain('إعادة تحميل تفاصيل الأمر');
    expect(markup).toContain('h-touch');
  });
});

describe('a logout the server never confirmed', () => {
  it('is not a logout, and is not the login screen', () => {
    const markup = surface({
      kind: 'logout-failed',
      principal: SOMEBODY,
      failure: LOGOUT_UNCONFIRMED,
    });

    expect(markup).toContain('لم يتم تأكيد الخروج');
    expect(markup).toContain(LOGOUT_UNCONFIRMED.message);
    expect(markup).toContain('إعادة محاولة تسجيل الخروج');
    expect(markup).not.toContain('<form');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('كلمة المرور');
    expect(markup).not.toContain('جارٍ تحميل المؤشرات');
    expect(markup).not.toContain('مبيعات آخر');
    expect(markup).not.toContain('ابحث في الأصناف');
    expect(markup).not.toContain('الفروع والصناديق');
    expect(markup).not.toContain(SOMEBODY.user.displayName);
  });

  it('shows the login form only once the server has said anonymous', () => {
    const markup = surface({ kind: 'anonymous', notice: null });
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('لم يتم تأكيد الخروج');
  });

  it('waits, rather than deciding, while a sign-out is in flight', () => {
    const markup = surface({ kind: 'signing-out', principal: SOMEBODY });
    expect(markup).toContain('جارٍ تسجيل الخروج بأمان');
    expect(markup).not.toContain('type="password"');
    expect(markup).not.toContain('ابحث في الأصناف');
  });

  it('maps each session state to exactly one screen', () => {
    expect(controlView({ kind: 'loading' })).toMatchObject({ kind: 'waiting' });
    expect(controlView({ kind: 'signing-out', principal: SOMEBODY })).toMatchObject({
      kind: 'waiting',
    });
    expect(
      controlView({ kind: 'logout-failed', principal: SOMEBODY, failure: LOGOUT_UNCONFIRMED }),
    ).toMatchObject({ kind: 'logout-unconfirmed' });
    expect(controlView({ kind: 'anonymous', notice: null })).toMatchObject({ kind: 'login' });
    expect(controlView({ kind: 'unavailable', failure: LOGOUT_UNCONFIRMED })).toMatchObject({
      kind: 'unavailable',
    });
    expect(controlView({ kind: 'ready', principal: SOMEBODY })).toMatchObject({ kind: 'ready' });
  });
});

describe('the till catalogue never claims to be ranked', () => {
  it('says the products are available, not that they are the most used', () => {
    const markup = renderToStaticMarkup(
      createElement(ProductPanel, {
        term: '',
        state: { term: '', status: 'ready', results: [MILK], failure: null },
        disabled: false,
        inputRef: null,
        onTermChange: () => undefined,
        onSubmitTerm: () => undefined,
        onPick: () => undefined,
      }),
    );

    expect(markup).toContain('الأصناف المتاحة');
    expect(markup).not.toContain('الأكثر استخداماً');
    expect(markup).not.toContain('الأكثر مبيعاً');
  });
});
