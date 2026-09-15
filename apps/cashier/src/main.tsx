import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PosApp } from '../../pos-web/src/components/pos-app';
import type { ApiClient } from '../../pos-web/src/lib/api';
import '../../pos-web/src/app/globals.css';
import { createCashierApiClient } from './cashier-api';
import { nativeFetch } from './native-fetch';

declare const __KORVI_SOURCE_SHA__: string;

const root = document.getElementById('root');
if (root === null) throw new Error('Korvi Cashier root element is missing.');

document.documentElement.dataset['korviSourceSha'] = __KORVI_SOURCE_SHA__;

const cashierApi = createCashierApiClient(nativeFetch);

createRoot(root).render(
  <StrictMode>
    <PosApp api={cashierApi as ApiClient} />
  </StrictMode>,
);
