# ADR-0002 — Money is integer minor units

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0

## Context

The strategy document names the decimal problem as a founding motivation:
systems that hold money in floating point generate fractional halalas that
surface later as an unexplained shortfall in bank reconciliation.

`0.1 + 0.2 !== 0.3` in IEEE 754. A POS adds prices thousands of times a day.

## Decision

Money is an integer count of minor units — halalas — held in a `bigint`:

```ts
interface Money {
  readonly currency: Currency;
  readonly minor: bigint;
}
```

Consequences of that choice, all enforced:

1. **No float ever touches an amount.** No `parseFloat`, no `Math.round`. The
   only sanctioned scaling operation is `mulDivRound`, which is bigint
   throughout.
2. **Rates are basis points as `bigint`.** 15% is `1500n`. A percentage as a
   float multiplied by a price reintroduces the problem the type was chosen to
   avoid.
3. **Strings at every JSON boundary.** `JSON.stringify` throws on `bigint`, and
   a `number` loses precision past 2^53. `moneyToJson` emits `minor` as a
   string; `moneyFromJson` validates it as an integer string.
4. **Parsing goes through `moneyFromMajorString`,** which reads `"12.34"`
   textually and rejects anything finer than a halala rather than rounding it
   away silently.
5. **`allocate` preserves the total.** Deterministic largest-remainder: floor
   shares first, leftover units to the largest fractional remainders, ties
   broken by index. `sum(allocate(total, weights)) === total` holds for every
   input including negatives — the test sweeps 501 totals across seven weight
   shapes.
6. **Change comes from cash only.** `settle` rejects a non-cash tender larger
   than the amount due with `NonCashChangeError`, because a card terminal has no
   mechanism to return money.

At the database layer, `priceMinor` is `BigInt` in Prisma, mapping to
PostgreSQL `BIGINT`.

## Consequences

- Arithmetic is verbose. `addMoney(a, b)` instead of `a + b`.
- `bigint` cannot be JSON-serialised directly, which is why the boundary
  functions exist and must be used.
- A whole class of reconciliation bug is unavailable by construction.
