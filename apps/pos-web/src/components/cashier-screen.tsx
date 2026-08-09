'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardSurface } from '@korvi/ui';
import { TopBar } from './top-bar';
import { ProductPanel } from './product-panel';
import { CartPanel } from './cart-panel';
import { CheckoutPanel } from './checkout-panel';
import { SaleReceipt } from './sale-receipt';
import { StatusNote } from './status-note';
import { previewCart } from '../lib/cart';
import { intentLocked, signOutBlocked } from '../lib/checkout';
import { shiftNeedsRefresh } from '../lib/shift';
import { autoAddCandidate } from '../lib/search';
import { hasPermission } from '../lib/session';
import { parseSarToMinor } from '../lib/money';
import { useCart } from '../hooks/use-cart';
import { useCheckout } from '../hooks/use-checkout';
import { useProductSearch } from '../hooks/use-product-search';
import type { JSX } from 'react';
import type { PriceMode } from '@korvi/domain';
import type { ApiClient } from '../lib/api';
import type { Principal, ProductSummary, ShiftSummary, TerminalSummary } from '../lib/api-types';

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
  const search = useProductSearch(api);
  const checkout = useCheckout(api, onExpired);
  const [cash, setCash] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const cashInput = useRef<HTMLInputElement>(null);

  const preview = useMemo(() => previewCart(cart.lines, priceMode), [cart.lines, priceMode]);
  const parsedCash = parseSarToMinor(cash);
  const cashMinor = parsedCash.ok ? parsedCash.value : null;
  const locked = intentLocked(checkout.state);
  const outstanding = checkout.state.attemptOutstanding;

  const focusSearch = useCallback(() => {
    searchInput.current?.focus();
  }, []);

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
    checkout.newSale();
    cart.dispatch({ type: 'clear' });
    setCash('');
    // Once, between customers — not once per item.
    search.browse();
    focusSearch();
  }, [checkout, cart, search, focusSearch]);

  const submit = useCallback(() => {
    if (cashMinor === null) return;
    checkout.submit({
      terminalId: terminal.id,
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
        showControlCentre={hasPermission(principal, 'report.read')}
        terminal={terminal}
        busy={checkout.state.phase === 'submitting'}
        signOutBlocked={signOutBlocked(checkout.state)}
        onSignOut={onSignOut}
      />

      <div className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
        <CardSurface className="flex min-h-0 flex-1 flex-col p-4">
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
          {completed === null ? (
            <CardSurface className="flex min-h-0 flex-1 flex-col p-4">
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
