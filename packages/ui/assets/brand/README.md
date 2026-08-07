# Korvi POS — brand assets

These files are the Korvi ERP lockup with the suffix changed from `ERP` to
`POS`. Nothing else was altered: same glyph outlines (IBM Plex Sans Arabic),
same colours, same cap-height ratio, same tracking, same baseline, same suffix
position.

The geometry was measured from the ERP lockup and normalised against the
wordmark cap height, so it is resolution-independent:

| Ratio                                   | Value    |
| --------------------------------------- | -------- |
| suffix cap height / wordmark cap height | 0.4058   |
| gap / wordmark cap height               | 0.472    |
| suffix tracking                         | 0.0687em |

Glyphs are outlined paths, not `<text>`: the files render identically with no
font installed, which is what makes them safe to hand to a print vendor.

| File                         | Use                                         |
| ---------------------------- | ------------------------------------------- |
| `korvi-pos-lockup.svg`       | Theme-aware, follows `prefers-color-scheme` |
| `korvi-pos-lockup-light.svg` | Fixed light — print, light backgrounds      |
| `korvi-pos-lockup-dark.svg`  | Fixed dark — dark backgrounds               |
| `korvi-pos-icon.svg`         | Square app icon and favicon                 |

## Inside the application, use `KorviMark` instead

KORVI-DESIGN-SYSTEM.md §8 is explicit that the in-product wordmark is text, not
an image: no file to lose, no second copy to keep in step with the theme, and it
prints cleanly. These SVGs are for the places a component cannot reach —
favicon, app icon, print vendors, marketing.

## Colour

`#047857` (`emerald-700`, the `--brand` token). This is deliberately **not** the
`--primary` teal `#196B60`. The mark is the one element that ignores the theme,
because it has to read the same on the light shell, the dark shell, and on white
paper — and paper has no theme. See §2.4. Do not round the HSL values.

## The one placement rule

Never in a tax invoice header. That header identifies the merchant who issued
the invoice; putting the software vendor's mark there tells an auditor that
Korvi sold the goods. Footer only, as "صُدرت عبر Korvi".
