import type { MetadataRoute } from 'next';

/**
 * Installed Korvi V1 is an installable local-first PWA on Windows and Android.
 * Native wrappers may be added later, but the web app remains the product and
 * the offline authority remains the same IndexedDB + service-worker boundary.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Korvi POS',
    short_name: 'Korvi',
    description: 'نظام كورفي لنقاط البيع وإدارة التشغيل',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#196B60',
    lang: 'ar',
    dir: 'rtl',
    categories: ['business', 'productivity'],
    icons: [
      {
        src: '/app-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/app-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/app-icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
