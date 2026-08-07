# ADR-0008 — Thermal printing and Arabic

- **Status:** Accepted
- **Date:** 2026-08-07
- **Phase:** 0
- **Supersedes:** the printing design in Phase 0 revision 1

## Context

Revision 1 selected an ESC/POS code page and then wrote text through a
`TextEncoder`, which emits UTF-8. That combination is wrong on most hardware in
the market.

An ESC/POS printer decodes incoming bytes through whichever code page it was
told to select. Handed UTF-8, it sees each Arabic letter as two bytes and prints
two unrelated glyphs for each. The result is not a subtle rendering defect — it
is an unreadable tax invoice, and it would have reached a merchant.

Three further assumptions in revision 1 were also unsafe: that every device
understands UTF-8, that Arabic needs no contextual shaping, and that a receipt
is complete without a QR code actually being emitted.

## Decision

**Devices are described, not assumed.** A `PrinterProfile` states what a model
can do: text encoding (`cp1256`, `cp864`, `utf8`, `raster`), whether Arabic must
be pre-shaped, whether the caller must reorder into visual order, QR support
(`native`, `raster`, `none`), column count and dot width. Every encoding
decision reads from that profile.

**The Arabic pipeline is explicit, and its order is fixed:**

1. **Shape** into Arabic Presentation Forms-B, on **logical** order.
2. **Reorder** the shaped result into visual order, for heads with no bidi
   algorithm.
3. **Map** to the target code page.

The order is the correctness point. Contextual shaping is defined over logical
adjacency: a letter's form depends on its neighbours as the word is _written_,
not as it is laid out on paper. Reordering first reverses that adjacency, so
every letter is shaped against the wrong neighbours — initial forms come out
final, medial joins break, and lam-alef never pairs because the lam now follows
the alef. The result is well-formed bytes spelling the word incorrectly.

Reordering after shaping is safe: presentation forms are still RTL characters,
so the reordering pass treats them exactly as it treats base letters.

Each step is skipped only when the device _declares_ it does that work itself
(`firmwareShapes`, `firmwareBidi`), and those declarations are per verified
model.

**An unidentified device gets no text path.** Revision 2 assumed unknown
hardware spoke CP1256 and shaped in firmware. That is a guess, and devices
differ on whether they shape, which Arabic page they carry, and whether they
carry one at all. `GENERIC_ESCPOS_UNKNOWN` therefore declares `text: 'raster'`
and `verified: false`, and the encoder refuses it outright: rendering to a
bitmap is slower and always correct, where a wrong guess is an unreadable tax
invoice. CP1256-with-firmware-shaping still exists as a profile, but only for
models someone has confirmed.

**Unmappable characters raise.** A receipt that quietly prints a substitute
glyph is worse than one that refuses, because nobody notices the first.

**QR is emitted as a symbol.** Native `GS ( k` where the firmware supports it,
otherwise a caller-supplied bitmap through `GS v 0`. A device with neither
throws: a simplified tax invoice without a scannable QR is not a valid
simplified tax invoice, and printing one anyway hands the merchant a document
that fails inspection with nobody at the till aware.

**Raster is a declared port, not a stub.** Devices with no Arabic code page need
their lines drawn as bitmaps, which needs a font and a layout engine — a Phase 1
dependency. `RasterRenderer` is declared now so the pipeline has the right
shape, and a raster-only profile fails loudly rather than silently taking a text
path that would print nonsense.

**Transport stays unimplemented.** Byte construction is worth testing
exhaustively and does not change when the cable does. USB, Bluetooth, network
and WebUSB become adapters behind `PrinterTransport` in Phase 1.

## Scope of the bidi implementation

`toVisualOrder` is a documented subset of UAX #9: strong-RTL, strong-LTR and
neutral runs, neutrals resolved to a flanking direction (rule N1), RTL runs
reversed. It handles what a receipt contains — Arabic prose with embedded Latin
codes and Western digits. It does not handle explicit overrides, isolates, or
nesting beyond depth one; those lines belong on the raster path where a real
implementation runs.

Rule N1 is load-bearing twice: it keeps a space between two Arabic words inside
the Arabic run, and — less obviously — keeps the decimal point inside `115.00`.
Without the second case the price is split into three runs and prints as
`00.115`. There is a test for exactly that.

## Consequences

- Adding a printer model means adding a profile, and a profile is a claim about
  hardware. Add one only after observing a real unit; an unverified profile
  produces confident garbage, which is worse than no profile.
- Receipt bytes differ per device. Tests assert on golden byte fixtures, because
  a test asserting "contains Arabic" would have passed against the revision 1
  bug.
- The shaping table covers Modern Standard Arabic as a receipt uses it. Extended
  Persian and Urdu letters are not mapped and will raise on the CP864 path.
