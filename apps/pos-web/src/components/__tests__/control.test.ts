import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ROLE_PERMISSIONS } from '@korvi/domain';
import { BranchesPanel } from '../control/branches-panel';
import { CONTROL_ENTRIES, ControlNav } from '../control/control-nav';
import { ControlSurface } from '../control/control-app';
import { DashboardPanel } from '../control/dashboard-panel';
import { MembersPanel } from '../control/members-panel';
import { ProductsPanel } from '../control/products-panel';
import { SettingsPanel } from '../control/settings-panel';
import { ProductPanel } from '../product-panel';
import { controlView } from '../../lib/control-view';
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
  it('names every planned module of the product', () => {
    expect(CONTROL_ENTRIES.map((entry) => entry.label)).toEqual([
      'الرئيسية',
      'المبيعات',
      'المنتجات',
      'المخزون',
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
        permissions: ['settings.manage', 'users.manage'],
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
    expect(markup.match(/غير مصرح/g) ?? []).toHaveLength(3);
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
    expect(peopleOnly.match(/غير مصرح/g) ?? []).toHaveLength(2);
  });

  it('marks exactly one section as the open one', () => {
    const markup = renderToStaticMarkup(
      createElement(ControlNav, {
        active: 'products',
        permissions: ['settings.manage', 'users.manage'],
        onSelect: () => undefined,
      }),
    );
    expect(markup.match(/aria-current="page"/g) ?? []).toHaveLength(1);
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
});

describe('who the control centre is for', () => {
  it('withholds it from a cashier and offers it to a manager', () => {
    expect(hasPermission(principalWith(ROLE_PERMISSIONS.cashier), 'report.read')).toBe(false);
    expect(hasPermission(principalWith(ROLE_PERMISSIONS.manager), 'report.read')).toBe(true);
    expect(hasPermission(principalWith(ROLE_PERMISSIONS.owner), 'report.read')).toBe(true);
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
