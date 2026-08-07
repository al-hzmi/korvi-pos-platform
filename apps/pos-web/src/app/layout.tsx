import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans_Arabic, IBM_Plex_Mono } from 'next/font/google';
import { THEME_COLOR_DARK, THEME_COLOR_LIGHT } from '@korvi/ui';
import './globals.css';

/**
 * Both families are downloaded at build time and served from our own origin —
 * no third-party request at runtime, and no flash of system font.
 *
 * Plex Sans Arabic rather than a display face: the "beautiful" Arabic fonts are
 * mostly Kufi display styles that fall apart in 13px interface text. Plex is a
 * text family with a Latin companion at matching weight, which is what stops
 * Latin looking foreign inside an Arabic sentence.
 */
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-plex-arabic',
  display: 'swap',
  adjustFontFallback: true,
});

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Korvi POS',
  description: 'نظام نقاط البيع للتجزئة والمطاعم',
  icons: { icon: '/brand/korvi-pos-icon.svg' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: THEME_COLOR_LIGHT },
    { media: '(prefers-color-scheme: dark)', color: THEME_COLOR_DARK },
  ],
  // A cashier's thumb must not zoom the till by accident, but pinch-zoom stays
  // available for anyone who needs it.
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  // RTL is the default direction, not a later addition. See §6.
  return (
    <html lang="ar" dir="rtl" className={`${plexArabic.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
