# ZATCA e-invoicing — implemented, deferred, and the required ordering

## What Phase 0 implements

`packages/domain/src/zatca/tlv.ts` builds the **Phase 1 simplified tax invoice
QR payload**: tags 1-5 (seller name, VAT registration number, timestamp,
invoice total including VAT, VAT total), TLV-encoded, then Base64.

Two properties, both deliberate:

- **Correct by construction.** Length bytes are UTF-8 **byte** counts, not
  character counts. An Arabic seller name runs roughly two bytes per letter, so
  a character count declares a length shorter than the payload and the parser
  walks off the end of the field.
- **Pure and deterministic.** No network, no ambient clock, no shared state.
  The same input yields byte-identical output on the terminal and on the server.

The symbol is genuinely printed — natively via `GS ( k`, or from a supplied
bitmap — and `renderReceipt` refuses to produce an invoice without one.

## What Phase 0 does not implement

**Tags 1-5 alone are not Phase 2 compliance.** Do not describe a build carrying
only this module as Phase 2 ready.

### The Phase 2 simplified tax invoice QR carries tags 1-9

| Tag | Content                                           |
| --- | ------------------------------------------------- |
| 1   | Seller name                                       |
| 2   | VAT registration number                           |
| 3   | Timestamp (ISO 8601)                              |
| 4   | Invoice total, VAT inclusive                      |
| 5   | VAT total                                         |
| 6   | Hash of the XML invoice                           |
| 7   | ECDSA signature (the cryptographic stamp)         |
| 8   | ECDSA public key of the cryptographic stamp       |
| 9   | ZATCA technical CA signature over that public key |

Tag 9 is the Authority's technical CA signature associated with the
cryptographic stamp's public key, and it belongs to **simplified** tax invoices
and their associated notes. All nine are required on a Phase 2 simplified
invoice.

Refer to the current official ZATCA e-invoicing specifications for the
authoritative field definitions before implementing any of tags 6-9. Nothing in
this repository should be treated as a substitute for them.

## The ordering that the architecture must preserve

This is the part that constrains Phase 1 design, so it is written down now.

For a Phase 2 simplified tax invoice, **local issuance is a single ordered
pipeline, and every step runs before the customer receives the document**:

```
deterministic sale totals
  -> compliant UBL XML
  -> required canonicalisation / transforms
  -> invoice hash
  -> cryptographic stamping using a valid CSID
  -> QR carrying tags 1-9
  -> immutable local persistence
  -> customer invoice / receipt issuance
```

Only after that does reporting begin:

```
reporting -> FATOORA API -> retry queue -> reconciliation
```

**Signing is not deferred past issuance.** A receipt handed to a customer must
already carry its hash, its stamp and its complete tag 1-9 QR. Reporting to the
Authority may be delayed and retried within the regulatory window — that part is
network work and can fail — but generating and signing locally cannot be
postponed until the reporting succeeds. An architecture that signs after
handing over the receipt produces documents that were never compliant at the
moment they were issued.

That is why the offline queue in ADR-0005 models _reporting_, not signing. The
queue exists for the network step only.

## How the deferred pieces fit

**CSID.** Signing needs a valid cryptographic stamp identifier, obtained by
onboarding and stored per device. It is a credential with a lifecycle, held
behind a `CredentialStorePort`. Behaviour when a certificate is absent, invalid
or expired is a compliance question to be answered from the official
specifications and the merchant's regulatory obligations — this repository does
not assert a policy for it.

**Hash and canonicalisation.** Canonicalisation is exact and textual, and must
produce identical bytes on the terminal and the server — the same requirement
the TLV encoder already meets, and the reason Base64 is written out by hand
rather than delegated to `Buffer`.

**Signing.** Local, synchronous, inside issuance. Not queued.

**Reporting and reconciliation.** Network calls with their own failure modes.
`RetryPolicy` exists so a systematic rejection does not become a tight loop
against the Authority's endpoint.

## The invariant that must survive Phase 2

Tags 1-5 for a given invoice must not change when signing arrives: tags 6-9 are
added alongside them. Any change to `simplifiedInvoiceQrFields` is a breaking
change to already-printed paper.
