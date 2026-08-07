/**
 * Korvi Design System — Tailwind preset.
 *
 * Transcribed from KORVI-DESIGN-SYSTEM.md §10, which is the authority
 * (ADR-0006). Tokens live as CSS variables in @korvi/ui so theming happens at
 * runtime without a rebuild; Tailwind consumes them through
 * `hsl(var(--token) / <alpha-value>)`, which is what makes `bg-primary/10` work
 * without a second variable per opacity step.
 *
 * Shared with Korvi ERP. Divergence here is divergence in the brand.
 *
 * CommonJS on purpose: PostCSS loads this synchronously, and a .cjs preset
 * needs no build step of its own.
 */
module.exports = {
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },

        // The brand mark, promoted from a stray Tailwind `emerald` to a token.
        // It deliberately does NOT follow the theme: it must read the same on
        // the light shell, the dark shell and on white paper, and paper has no
        // theme. See KORVI-DESIGN-SYSTEM.md §2.4.
        brand: {
          DEFAULT: 'hsl(var(--brand) / <alpha-value>)',
          'on-dark': 'hsl(var(--brand-on-dark) / <alpha-value>)',
        },
      },

      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },

      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
        numeric: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },

      // Touch targets. `h-10` (40px) is below the 44px minimum in WCAG 2.5.5:
      // it works with a mouse and mis-taps with a thumb. Additive, so ERP
      // components keep their existing heights.
      spacing: {
        touch: '2.75rem',
        'touch-lg': '3rem',
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-start': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        // Two separate keyframes because the backdrop and the panel must not
        // move together: the blur fades straight in while the panel rises into
        // it, which is what makes the panel read as sitting *above* the page.
        'overlay-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'palette-in': {
          from: { opacity: '0', transform: 'translateY(-8px) scale(0.97)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },

      animation: {
        // One decelerating curve for the whole system: things arrive rather
        // than stop.
        'fade-in': 'fade-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-start': 'slide-in-start 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        shimmer: 'shimmer 1.6s infinite',
        'overlay-in': 'overlay-in 120ms ease-out',
        'palette-in': 'palette-in 160ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
