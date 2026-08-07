/**
 * The one place a colour literal is allowed, and the reason why.
 *
 * `<meta name="theme-color">` is read by the browser and the operating system
 * to tint chrome around the page — the address bar, the task switcher card.
 * That consumer is outside the document, so it cannot resolve a CSS variable;
 * it needs a literal value at render time.
 *
 * These two must stay equal to `--background` in each theme. If a token
 * changes, change these with it. The invariant scan excludes this file by name
 * precisely so the exception stays visible in one place rather than spreading.
 */
export const THEME_COLOR_LIGHT = '#FFFFFF'; // --background light: 0 0% 100%
export const THEME_COLOR_DARK = '#0E121B'; // --background dark: 222 30% 8%
