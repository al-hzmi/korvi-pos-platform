# ADR-0015 — Commercial settlement: tenders and discounts

Status: accepted
Date: 2026-08-18
Extends ADR-0002 (money), ADR-0004 (multi-tenancy), ADR-0013 (the checkout
transaction).

Scope: the sale side of the commercial core. Returns, refunds, drawer
movements and shift close are Strike 3B-1b and are deliberately not here.

## Context

Until this strike a Korvi sale was cash, whole, and undiscounted. That is a
real shop for about a week. What a merchant actually needs is to take part of a
sale on a card and the rest in cash, and to take money off a price without
handing the cashier the ability to give the shop away.

Both are arithmetic problems before they are feature problems, and the
arithmetic is where a POS quietly loses money.

## Decision 1 — Two request shapes, one settlement engine

`POST /v1/sales` accepts either `cashReceivedMinor` — the shape the production
till sends today — or a `tenders` array. Exactly one. A request carrying both
is refused, because a client that sends both does not know which it means and
guessing on its behalf is how a sale gets settled twice over.

The legacy figure is normalised into a one-line cash tender at the edge of the
service. Everything after that point sees a tender list. There is no second
checkout path and there must never be one: two implementations of the
arithmetic that decides what a customer is charged will diverge, quietly, on
whichever path is exercised least.

## Decision 2 — Electronic tender is a record, not a payment

Korvi does not contact a bank, a scheme, an acquirer, a gateway or a wallet.
An `electronic` tender means: _this payment was approved somewhere else, and
Korvi is recording the settlement._ Nothing in the code, the schema or the API
should ever be read as claiming otherwise.

What it carries: a closed list of schemes (`mada`, `visa`, `mastercard`,
`amex`, `apple-pay`, `other`) and an external reference, bounded to 64
characters. The scheme is closed because it is a label on a financial row that
every future report groups by, and an open string would put unbounded operator
text into that.

What it does not carry, and what the API refuses at any nesting depth — by
field name _and_ by value: PAN, card number, CVV/CVC, track data, expiry, PIN,
EMV data. The value check matters more than the name check, because a broken
integration will put a card number in a field called `reference` long before it
puts one in a field called `pan`. Anything that normalises to 13–19 digits and
satisfies Luhn is treated as a probable card number and refused, at the HTTP
edge and again in the domain. The refusal names no value and echoes nothing: a
message that quotes the number is a message that writes it down. Ordinary
approval codes — shorter, or carrying letters, or failing the checksum — are
unaffected. A client sending
those has a bug that will keep sending them, and the person who should find out
is the developer rather than an auditor reading a database years later. Korvi
is not in the cardholder-data business, and the refusal is where that stops
being a policy and starts being a control.

The older `card` / `mada` / `transfer` kinds remain readable so rows already
committed still map. No route writes them.

## Decision 3 — Change comes from cash, and only from cash

The settlement rules, all enforced in the domain rather than in a route,
because a till, an integration and a repair script must be refused the same
things:

- the tenders must cover the total, or the sale is underpaid;
- the electronic total may never exceed the amount due — a card charged 24.00
  against a 23.00 sale is a customer overcharged, and no amount of cash in the
  drawer can give it back, so it is refused rather than settled;
- change is drawn from cash and attributed to the cash tender row. An
  electronic row with change on it would describe a card terminal handing money
  back. The database refuses it too (`tenders_change_cash_only`,
  `tenders_change_within_amount`);
- at most one cash tender. Two cash lines is a drawer nobody can reconcile:
  the change has to come out of one of them and no fact says which;
- no zero tender, because a zero line records a method that was not used and
  it reaches a receipt;
- no repeated `(scheme, reference)`, because two lines pointing at one approval
  double-count somebody else's transaction. Two different references on the
  same scheme are fine — a customer may present two cards.

What stays in the drawer from a sale is therefore `cash tendered − change`,
and that — not the sale total — is what the sale's cash movement records. The
total was right only while every sale was cash: on a split payment the card
settles part of it and never touches the till, so recording the total would
overstate the drawer by exactly the electronic portion, every day, with nothing
to point at. A sale settled entirely on a card writes **no** cash movement at
all; a zero row would be a movement that did not happen. This is the figure
Strike 3B-1b reconciles against.

The API response tells the three apart, because they are three different
facts: `tenderedMinor` (everything presented), `cashReceivedMinor` (the cash
tender alone) and `changeMinor`. On a cash-only sale the first two are equal,
which is why the 3A-2 browser is unaffected. A `tenders` array carries the
composition for the receipt, read from the persisted rows on a fresh sale and
on a replay alike.

## Decision 4 — A discount needs the permission _and_ the ceiling

`maxDiscountBasisPoints` says how much. It does not say whether at all. A
principal can hold a role-derived ceiling while their persisted permission set
omits `sale.discount`, and permissions — not roles — are what this server
checks. Any line or basket discount therefore requires both: the permission in
the persisted grant, and the amount inside the ceiling. Neither is ever read
from the request.

A sale with no discount needs only `sale.create`, exactly as before.

## Decision 5 — A discount ceiling that rounding cannot walk through

Discounts are line-level or basket-level, and either a rate in basis points or
a fixed number of halalas. The authority is `maxDiscountBasisPoints` on the
authenticated principal, resolved from persisted roles — never from the
request. A cashier's ceiling is `0`, so a cashier grants nothing; a manager's
is 2000 bp.

A fixed discount has to be comparable to a rate ceiling or the ceiling means
nothing against half the discounts a shop gives. So it is converted to the rate
it represents, against the undiscounted gross:

```
effectiveBp = ceil(grantedMinor × 10000 / eligibleBase)
```

**Rounded up, and that is the point.** Truncating division is the obvious way
to write it and it is wrong in a way nobody notices: 200 halalas off a base of
1999 is 1000.5 bp, and truncation reports 1000 — so a cashier capped at 1000 bp
is granted it, every time, repeatably. One halala over the ceiling as a policy
the merchant never set. Ceiling division means the ceiling is a ceiling: a
discount is authorised only if the rate it truly represents is inside it.

Over the ceiling is a deterministic refusal (`discount-not-authorized`, HTTP
403), never a silent clamp. Clamping would charge the customer a different
price from the one the cashier promised them.

### The base is the base it was taken from

Comparing every discount against the _cart_ gross lets a fixed amount destroy a
small line and still look modest: a manager capped at 2000 bp, given a 10.00
line beside a 90.00 line, could take 10.00 off the small one — a 100 per cent
discount on that line — because 10.00 of a 100.00 cart reads as 1000 bp. So
each scope is measured against its own base:

- a **line** discount against that line's undiscounted extended price;
- a **basket** discount against the basket _after_ line discounts, because that
  is the base `priceCart` actually applies it to;
- and then **everything together** against the undiscounted cart gross, so
  several individually-legal discounts cannot be stacked into an illegal one.

A fixed amount larger than the base it is taken from is refused as
`invalid-discount` — not capped. `applyDiscount` clamps such a value, which is
right for pricing and wrong for authorisation: clamping answers a request
nobody made, at a price the cashier never quoted. Exceeding _authority_ with an
otherwise valid amount is `discount-not-authorized`. The two are told apart
because a cashier fixes them in different places.

## Decision 6 — Allocation reconciles exactly

A basket discount is allocated across lines with the same largest-remainder
routine money uses everywhere else, so the per-line shares sum to the discount
exactly. Applying a percentage to each line independently would not — the
halalas would not add up and the receipt would not reconcile.

The invariants, asserted in the domain and again by the database's own CHECK
constraints:

```
Σ line basket-discount shares = basket discount
gross − line discounts − basket discount = net
net + VAT = total
tendered − change = total
```

No line net goes below zero. No discount exceeds its eligible base.

## Decision 7 — Persist what explains the receipt

Every applied discount is written with its scope, its kind, the value that was
_requested_, the amount that was actually _granted_, the reason, the user who
granted it and when. A receipt has to be explainable years later from what was
written, not by replaying today's pricing rules against a catalogue that has
moved on.

`grantedByUserId` carries a composite tenant-consistent foreign key to `users`.
A discount attributed to a user in another tenant is not an audit trail, and a
plain reference to `users(id)` would permit exactly that (ADR-0004).

## Decision 8 — Payment is part of the intent

The idempotency fingerprint (ADR-0013) now covers the tender composition and
the discounts as well as the basket. The same basket settled as 50 cash + 50
Mada is a different commercial event from the same basket settled in cash: the
drawer differs, the reconciliation differs, and the customer's card statement
differs. Replaying one as the other would be wrong in a way nobody could
reconstruct afterwards.

The canonical form is a **structured value serialised as JSON**, not a string
joined with hand-picked delimiters. That distinction is load-bearing: an
approval reference is free text, and a reference containing `:` and `,` can
spell out a second tender record. `reference = "R,electronic:visa:100:X"` on one
tender produces the same joined string as two tenders referenced `"R"` and
`"X"` — two materially different sales, one fingerprint, and a replay that
returns the wrong one. SHA-256 cannot repair an ambiguous serialisation; it
faithfully hashes the collision. JSON gives the separators structure instead of
meaning. Records are sorted by their own serialisation before hashing, so key
order does not matter while content still does.

The fingerprint is versioned `v2`. A key minted under `v1` hashes differently
and is treated as a different intent — a visible conflict rather than an
invisible false replay, which is the safe direction.

Because both request shapes normalise before hashing, a legacy cash request
retried as its tender equivalent is a _replay_, not a conflict.

### Backed by the database

The two composition rules are also PostgreSQL invariants: a partial unique
index on `(tenantId, saleId) WHERE kind = 'cash'`, and another on
`(tenantId, saleId, scheme, reference) WHERE kind = 'electronic'`. Defence in
depth — the domain refuses both first, so an ordinary checkout never meets a
unique violation. What they stop is everything that is not an ordinary
checkout: a repair script, a migration, an integration written against the
tables.

## Consequences

- A merchant can take a split payment and give change correctly, or be told
  precisely why the payment was refused.
- A discount is bounded by the merchant's policy rather than by the interface,
  and the bound cannot be crossed by rounding.
- Everything needed to print an authoritative receipt for a discounted,
  split-tender sale is persisted. Printing itself is a later strike.
- No cardholder data enters the system, by construction rather than by
  convention.
- ZATCA Phase 2 is untouched and not claimed. The rows this strike writes —
  discount provenance, per-rate VAT buckets, tender composition — are the
  accounting facts that pipeline will need, which is why they are persisted
  rather than derived.
