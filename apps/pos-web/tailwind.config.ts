import type { Config } from 'tailwindcss';
import korviPreset from '@korvi/config/tailwind-preset';

/**
 * The preset carries the whole design system (ADR-0006). This file only says
 * where to look for classes — including the shared UI package, whose classes
 * would otherwise be tree-shaken out of the stylesheet.
 */
const config: Config = {
  presets: [korviPreset as Config],
  content: ['./src/**/*.{ts,tsx}', '../../packages/ui/src/**/*.{ts,tsx}'],
};

export default config;
