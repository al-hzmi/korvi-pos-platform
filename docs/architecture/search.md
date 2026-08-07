# Liquid Search — boundary

Declared in Phase 0, implemented later.

## Target

Sub-50ms prefix lookup against the local store while the cashier is still
typing, tolerant of the transpositions that hurried entry produces. Local first:
a search that needs the network is a search that stops during an outage.

## codeReverse

A cashier who cannot scan reads the **last** few digits off the label. That is a
suffix query, and a suffix query against a forward index is a full scan.

Storing the reversed barcode alongside the forward one turns the suffix query
into a prefix query, which the same ordered index can serve. `Product` carries a
`codeReverse` column indexed as `[tenantId, codeReverse]`, and
`codeReverse(code)` in `ports/search.ts` produces the value.

## What is not decided

The ranking function, the fuzzy-match tolerance, and where the index lives
(IndexedDB, SQLite WASM, or Postgres with a trigram index). Those need
measurement against a real catalogue — a national barcode set is hundreds of
thousands of rows, and a ranking that feels right on a hundred items behaves
differently at that scale.

`LiquidSearchPort` is the contract; the implementation is Phase 1+.
