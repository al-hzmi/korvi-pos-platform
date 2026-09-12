'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, CardSurface } from '@korvi/ui';
import { TopBar } from './top-bar';
import { canOpenControlCentre } from './control/control-nav';
import { ProductPanel } from './product-panel';
import { CartPanel } from './cart-panel';
import { CheckoutPanel } from './checkout-panel';
import { SaleReceipt } from './sale-receipt';
import { StatusNote } from './status-note';
import { previewCart } from '../lib/cart';
import { intentLocked, signOutBlocked } from '../lib/checkout';
import { createDurableProductSource } from '../lib/offline-search-source';
import { shiftNeedsRefresh } from '../lib/shift';
import { autoAddCandidate } from '../lib/search';
import { parseSarToMinor } from '../lib/money';
import { useCart } from '../hooks/use-cart';
import { useCheckout } from '../hooks/use-checkout';
import { useOfflineSaleSync } from '../hooks/use-offline-sale-sync';
import { useDurableSaleDraft } from '../hooks/use-durable-sale-draft';
import { useProductSearch } from '../hooks/use-product-search';
import type { JSX } from 'react';
import type { PriceMode } from '@korvi/domain';
import type { ApiClient } from '../lib/api';
import type { Principal, ProductSummary, ShiftSummary, TerminalSummary } from '../lib/api-types';
import type { OfflineSaleScope } from '../lib/offline-store';

/**
 * Where a cashier spends the whole day.
 *
 * The eye moves search -> product -> cart -> total -> pay, and the layout says
 * so: the search field is the largest control on the screen and the total is
 * the largest number. Nothing else competes for attention.
 *
 * One rule governs everything below: while a checkout may or may not have
 * committed, nothing that feeds the request may change — not the basket, not a
 * quantity, not the cash, not the search box, and not the session. The retry
 * has to be able to resend the same intent, and an edited field would make it
 * a different one.
 */
export interface CashierScreenProps {
  readonly api: ApiClient;
  readonly principal: Principal;
  readonly terminal: TerminalSummary;
  /** The drawer this till is selling through. The server re-checks it anyway. */
  readonly shift: ShiftSummary;
  /** From tenant_settings, by way of GET /v1/terminals. Never guessed here. */
  readonly priceMode: PriceMode;
  readonly onSignOut: () => void;
  readonly onExpired: () => void;
  readonly onShiftChanged: () => void;
}

export function CashierScreen({
  api,
  principal,
  terminal,
  shift,
  priceMode,
  onSignOut,
  onExpired,
  onShiftChanged,
}: CashierScreenProps): JSX.Element {
  const cart = useCart();
  const productSource = useMemo(
    () => createDurableProductSource(api, principal.tenant.id),
    [api, principal.tenant.id],
  );
  const search = useProductSearch(productSource);
  const queuePartition = useMemo(
    () => ({
      tenantId: principal.tenant.id,
      branchId: terminal.branchId,
      terminalId: terminal.id,
    }),
    [principal.tenant.id, terminal.branchId, terminal.id],
  );
  const checkout = useCheckout(api, onExpired, queuePartition);
  const offlineSync = useOfflineSaleSync(api, queuePartition, onExpired);
  const [cash, setCash] = useState('');
  const [draftHydrated, setDraftHydrated] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const cashInput = useRef<HTMLInputElement>(null);

  const durableScope = useMemo<OfflineSaleScope>(
    () => ({
      tenantId: principal.tenant.id,
      branchId: terminal.branchId,
      terminalId: terminal.id,
      userId: principal.user.id,
      shiftId: shift.id,
    }),
    [principal.tenant.id, principal.user.id, shift.id, terminal.branchId, terminal.id],
  );
  const {
    state: durableState,
    persist: persistDraft,
    clear: clearDraft,
  } = useDurableSaleDraft(durableScope);

  const preview = useMemo(() => previewCart(cart.lines, priceMode), [cart.lines, priceMode]);
  const parsedCash = parseSarToMinor(cash);
  const cashMinor = parsedCash.ok ? parsedCash.value : null;
  const durabilityLoading = !draftHydrated;
  const locked = intentLocked(checkout.state) || durabilityLoading;
  const outstanding = checkout.state.attemptOutstanding;

  const focusSearch = useCallback(() => {
    searchInput.current?.focus();
  }, []);

  useEffect(() => {
    setDraftHydrated(false);
  }, [durableScope]);

  useEffect(() => {
    if (draftHydrated || durableState.status === 'loading') return;
    if (durableState.status === 'ready' && durableState.draft !== null) {
      cart.dispatch({ type: 'replace', lines: durableState.draft.lines });
      setCash(durableState.draft.cash);
    }
    // A failed local store must never masquerade as durable. It does not,
    // however, revoke the server's online sale authority; the warning below
    // stays visible and the cashier can continue online.
    setDraftHydrated(true);
  }, [cart.dispatch, draftHydrated, durableState]);

  useEffect(() => {
    if (!draftHydrated || durableState.status !== 'ready') return;
    if (checkout.state.phase === 'succeeded' || checkout.state.phase === 'queued') {
      clearDraft();
      return;
    }
    if (cart.lines.length === 0 && cash === '') {
      clearDraft();
      return;
    }
    persistDraft({
      lines: cart.lines,
      cash,
      priceMode,
      updatedAt: new Date().toISOString(),
    });
  }, [
    cart.lines,
    cash,
    checkout.state.phase,
    clearDraft,
    draftHydrated,
    durableState.status,
    persistDraft,
    priceMode,
  ]);

  // The opening grid. A till that shows nothing until somebody types looks
  // broken, and in a shop with a short catalogue the cashier should not have
  // to type at all. Runs once, on the first render of a ready workspace.
  const browse = search.browse;
  useEffect(() => {
    browse();
  }, [browse]);

  const add = useCallback(
    (product: ProductSummary) => {
      if (locked) return;
      cart.dispatch({ type: 'add', product });
      search.reset();
      // Straight back to the field, so the next scan lands somewhere.
      focusSearch();
    },
    [cart, search, locked, focusSearch],
  );

  const submitTerm = useCallback(() => {
    if (locked) return;
    const candidate = autoAddCandidate(search.state);
    if (candidate !== null) {
      add(candidate);
      return;
    }
    search.runNow(search.term);
  }, [search, add, locked]);

  // A shift that stopped being usable — closed under the till, taken by
  // another cashier, or never opened — is not something to keep selling
  // through. The screen above re-reads it and decides.
  useEffect(() => {
    if (shiftNeedsRefresh(checkout.state.failure?.action)) onShiftChanged();
  }, [checkout.state.failure, onShiftChanged]);

  // The cash field is where the cashier has to look next.
  useEffect(() => {
    if (checkout.state.failure?.action === 'amend-cash') cashInput.current?.focus();
  }, [checkout.state.failure]);

  const newSale = useCallback(() => {
    clearDraft();
    checkout.newSale();
    cart.dispatch({ type: 'clear' });
    setCash('');
    // Once, between customers — not once per item.
    search.browse();
    focusSearch();
  }, [checkout, cart, clearDraft, search, focusSearch]);

  const submit = useCallback(() => {
    if (cashMinor === null) return;
    checkout.submit({
      terminalId: terminal.id,
      expectedShiftId: shift.id,
      lines: cart.lines,
      cashReceivedMinor: cashMinor,
    });
  }, [checkout, terminal.id, cart.lines, cashMinor]);

  const completed = checkout.state.phase === 'succeeded' ? checkout.state.sale : null;
  // Named so the value is used rather than merely accepted: a screen that
  // takes a shift it never reads is a screen that will drift out of step.
  const drawerLabel = `الوردية ${shift.id.slice(0, 8)}`;

  return (
    <div className="flex h-screen flex-col bg-muted/40">
      <TopBar
        cashierName={principal.user.displayName}
        showControlCentre={canOpenControlCentre(principal.permissions)}
        terminal={terminal}
        busy={checkout.state.phase === 'submitting'}
        signOutBlocked={signOutBlocked(checkout.state)}
        onSignOut={onSignOut}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
        <CardSurface className="flex min-h-0 flex-1 flex-col p-4">
          {offlineSync.state.needsReview.length > 0 ? (
            <StatusNote tone="warning" className="mb-3" live>
              توجد {offlineSync.state.needsReview.length} عملية بيع دون اتصال رفضها الخادم وتحتاج
              مراجعة. لم تُحذف ولم تُحوّل إلى بيع معتمد محلياً.
            </StatusNote>
          ) : null}
          {offlineSync.state.pendingCount > 0 ? (
            <StatusNote tone="info" className="mb-3" live>
              توجد {offlineSync.state.pendingCount} عملية محفوظة محلياً بانتظار التسوية مع الخادم.
            </StatusNote>
          ) : null}
          {offlineSync.state.status === 'failed' ? (
            <StatusNote tone="warning" className="mb-3" live>
              تعذّرت قراءة حالة مزامنة العمليات المحلية. ستبقى العمليات في التخزين المحلي حتى إعادة
              المحاولة.
            </StatusNote>
          ) : null}
          {durableState.status === 'failed' ? (
            <StatusNote tone="warning" className="mb-3" live>
              التخزين المحلي غير متاح. البيع المتصل يعمل، لكن لا تعتمد على استعادة السلة بعد إغلاق
              الصفحة.
            </StatusNote>
          ) : null}
          <ProductPanel
            term={search.term}
            state={search.state}
            disabled={locked}
            inputRef={searchInput}
            onTermChange={search.setTerm}
            onSubmitTerm={submitTerm}
            onPick={add}
          />
        </CardSurface>

        <aside
          className="flex min-h-0 w-full shrink-0 flex-col lg:w-[26rem]"
          aria-label={`السلة والدفع — ${drawerLabel}`}
        >
          {checkout.state.phase === 'queued' && checkout.state.intent !== null ? (
            <CardSurface className="flex min-h-0 flex-1 flex-col gap-4 p-4">
              <StatusNote tone="warning" live>
                تم حفظ البيع محلياً بنفس معرّف العملية وسيُرسل للخادم دون تغيير عند عودة الاتصال.
                هذه ليست فاتورة ضريبية معتمدة بعد؛ المخزون والضريبة والحسابات تبقى بانتظار سلطة
                الخادم.
              </StatusNote>
              <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
                <p className="font-semibold">بيع دون اتصال — محفوظ بأمان</p>
                <p className="mt-2 break-all text-muted-foreground">
                  معرّف العملية: {checkout.state.intent.operationId}
                </p>
                <p className="mt-1 text-muted-foreground">المبلغ المستلم: {cash} ر.س</p>
              </div>
              <Button size="lg" onClick={newSale}>
                بدء بيع جديد
              </Button>
            </CardSurface>
          ) : completed === null ? (
            <CardSurface className="flex min-h-0 flex-1 flex-col p-4">
              {durabilityLoading ? (
                <StatusNote tone="info" className="mb-3" live>
                  جاري استعادة حالة البيع المحلية…
                </StatusNote>
              ) : null}
              {outstanding ? (
                <StatusNote tone="warning" className="mb-3" live>
                  العملية معلّقة ولم تُحسم. السلة والمبلغ مقفلان حتى تُعاد بنفس العملية.
                </StatusNote>
              ) : null}
              <CartPanel
                lines={cart.lines}
                preview={preview}
                locked={locked}
                dispatch={cart.dispatch}
              />
              <CheckoutPanel
                totalMinor={preview.total.minor.toString()}
                netMinor={preview.net.minor.toString()}
                vatMinor={preview.vat.minor.toString()}
                cash={cash}
                cashMinor={cashMinor}
                lineCount={cart.lines.length}
                locked={locked}
                state={checkout.state}
                cashRef={cashInput}
                onCashChange={setCash}
                onSubmit={submit}
                onDismiss={checkout.dismiss}
              />
            </CardSurface>
          ) : (
            <SaleReceipt sale={completed} replayed={checkout.state.replayed} onNewSale={newSale} />
          )}
        </aside>
      </div>
    </div>
  );
}
