import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LoginScreen } from '../components/login-screen';
import { BlockedScreen, TerminalPicker } from '../components/terminal-picker';
import { ShiftGate } from '../components/shift-gate';
import { CashierScreen } from '../components/cashier-screen';
import { SaleReceipt } from '../components/sale-receipt';
import { FOREIGN_SHIFT } from '../lib/shift';
import type { ApiClient } from '../lib/api';
import type { Principal, SaleSummary, ShiftSummary, TerminalSummary } from '../lib/api-types';

/**
 * Every screen, rendered.
 *
 * Not a substitute for using the till, and not claimed to be: this is a static
 * render, so no effect runs and no click is dispatched. What it does prove is
 * that each screen composes, that the props each one demands are the props it
 * is given, and that the Arabic and the server-supplied figures reach the
 * markup rather than a formatter throwing on the way.
 */

const api = {} as ApiClient;

const PRINCIPAL: Principal = {
  user: { id: 'u1', email: 'sara@korvi-a.test', displayName: 'سارة' },
  tenant: { id: 't1', slug: 'korvi-a' },
  session: { id: 's1' },
  roles: ['cashier'],
  permissions: ['product.read', 'sale.create', 'shift.open'],
  branchId: '018f2000-0000-7000-8000-0000000000a1',
};

const BRANCH = '018f2000-0000-7000-8000-0000000000a1';

const TILL: TerminalSummary = {
  id: 'tm1',
  code: '01',
  label: 'صندوق ١',
  branchId: BRANCH,
};

const SHIFT: ShiftSummary = {
  id: 'sh1',
  branchId: '018f2000-0000-7000-8000-0000000000a1',
  terminalId: 'tm1',
  userId: 'u1',
  status: 'open',
  openingFloatMinor: '20000',
  openedAt: '2026-08-12T06:00:00.000Z',
};

const SALE: SaleSummary = {
  saleId: 'sale-1',
  operationId: 'op-1',
  sequence: 12,
  invoiceNumber: '01-000012',
  issuedAt: '2026-08-12T07:00:00.000Z',
  currency: 'SAR',
  branchId: '018f2000-0000-7000-8000-0000000000a1',
  terminalId: 'tm1',
  shiftId: 'sh1',
  cashierName: 'سارة',
  lines: [
    {
      lineNumber: 1,
      productId: 'p-milk',
      sku: 'MILK-1L',
      nameAr: 'حليب طازج',
      quantityScaled: '2000',
      unitPriceMinor: '1150',
      netMinor: '2000',
      vatMinor: '300',
      totalMinor: '2300',
    },
  ],
  netMinor: '2000',
  vatMinor: '300',
  totalMinor: '2300',
  cashReceivedMinor: '5000',
  changeMinor: '2700',
};

const noop = (): void => undefined;

describe('login', () => {
  const markup = renderToStaticMarkup(
    createElement(LoginScreen, { api, onAuthenticated: noop, notice: null }),
  );

  it('labels all three fields', () => {
    expect(markup).toContain('رمز المنشأة');
    expect(markup).toContain('البريد الإلكتروني');
    expect(markup).toContain('كلمة المرور');
  });

  it('uses real labels and password autocomplete', () => {
    expect(markup).toContain('for="tenant-slug"');
    // Case-insensitive: HTML attribute names are, and React's static renderer
    // passes this one through in the casing it was written in.
    expect(markup).toMatch(/autocomplete="organization"/i);
    expect(markup).toMatch(/autocomplete="username"/i);
    expect(markup).toMatch(/autocomplete="current-password"/i);
    expect(markup).toContain('type="password"');
  });
});

describe('terminal and shift', () => {
  it('lists the tills on offer', () => {
    const markup = renderToStaticMarkup(
      createElement(TerminalPicker, {
        terminals: [TILL, { ...TILL, id: 'tm2', code: '02', label: 'صندوق ٢' }],
        onChoose: noop,
        onSignOut: noop,
      }),
    );
    expect(markup).toContain('صندوق ١');
    expect(markup).toContain('صندوق ٢');
  });

  it('asks for the opening float in riyals', () => {
    const markup = renderToStaticMarkup(
      createElement(ShiftGate, {
        terminal: TILL,
        busy: false,
        failure: null,
        onOpen: noop,
        onChangeTerminal: null,
        onSignOut: noop,
      }),
    );
    expect(markup).toContain('النقد الافتتاحي');
    expect(markup).toContain('فتح الوردية');
  });
});

describe('the cashier workspace', () => {
  const markup = renderToStaticMarkup(
    createElement(CashierScreen, {
      api,
      principal: PRINCIPAL,
      terminal: TILL,
      shift: SHIFT,
      priceMode: 'tax-inclusive',
      onSignOut: noop,
      onExpired: noop,
      onShiftChanged: noop,
    }),
  );

  it('opens on the search field with an empty cart', () => {
    expect(markup).toContain('ابحث أو امسح الباركود');
    expect(markup).toContain('السلة فارغة');
  });

  it('shows the cashier, the till and an open shift in words', () => {
    expect(markup).toContain('سارة');
    expect(markup).toContain('صندوق ١');
    expect(markup).toContain('وردية مفتوحة');
  });

  it('gives branch context without printing an internal identifier at a customer', () => {
    expect(markup).toContain('الفرع الحالي');
    expect(markup).not.toContain(BRANCH.slice(0, 8));
  });

  it('shows a zero total rather than nothing', () => {
    expect(markup).toContain('المطلوب');
    expect(markup).toContain('0.00');
  });
});

describe('the states a cashier cannot sell out of', () => {
  it('says a logout was not confirmed instead of showing the login form', () => {
    // The failure this guards: the cookie is HttpOnly, so an unconfirmed
    // logout leaves the session live. A login screen here would tell a cashier
    // they had left a till that will restore them on reload.
    const markup = renderToStaticMarkup(
      createElement(BlockedScreen, {
        title: 'لم يتم تأكيد الخروج',
        tone: 'danger',
        failure: {
          code: 'logout_unconfirmed',
          message: 'لم يؤكّد الخادم إنهاء الجلسة، وقد تكون ما تزال مفتوحة.',
          action: 'blocking',
        },
        onRetry: noop,
        retryLabel: 'إعادة محاولة تسجيل الخروج',
      }),
    );
    expect(markup).toContain('لم يؤكّد الخادم');
    expect(markup).toContain('إعادة محاولة تسجيل الخروج');
    expect(markup).not.toContain('كلمة المرور');
  });

  it('offers another till when the drawer belongs to somebody else', () => {
    const markup = renderToStaticMarkup(
      createElement(BlockedScreen, {
        title: 'الوردية تخصّ كاشيراً آخر',
        failure: FOREIGN_SHIFT,
        onRetry: noop,
        onChangeTerminal: noop,
        onSignOut: noop,
      }),
    );
    expect(markup).toContain('وردية مفتوحة لكاشير آخر');
    expect(markup).toContain('اختيار صندوق آخر');
  });
});

describe('the completed sale', () => {
  const markup = renderToStaticMarkup(
    createElement(SaleReceipt, { sale: SALE, replayed: false, onNewSale: noop }),
  );

  it('shows the server’s invoice number and figures, not the cart’s', () => {
    expect(markup).toContain('01-000012');
    expect(markup).toContain('23.00');
    expect(markup).toContain('27.00');
    expect(markup).toContain('3.00');
  });

  it('prints a time a person can read rather than an ISO string', () => {
    expect(markup).not.toContain('2026-08-12T07:00:00.000Z');
    expect(markup).toContain('2026');
  });

  it('offers the next sale as the primary action', () => {
    expect(markup).toContain('عملية بيع جديدة');
  });

  it('says when a response was a replay rather than a new sale', () => {
    const replayed = renderToStaticMarkup(
      createElement(SaleReceipt, { sale: SALE, replayed: true, onNewSale: noop }),
    );
    expect(replayed).toContain('مسجّلة مسبقاً');
  });
});
