import type { Config } from 'tailwindcss';
import korviPreset from '@korvi/config/tailwind-preset';

const config: Config = {
  presets: [korviPreset as Config],
  content: [
    './src/**/*.{ts,tsx}',
    '../pos-web/src/components/**/*.{ts,tsx}',
    '../pos-web/src/hooks/**/*.{ts,tsx}',
    '../pos-web/src/lib/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
};

export default config;
