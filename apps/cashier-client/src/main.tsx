import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PosApp } from '../../pos-web/src/components/pos-app';
import { createApiClient } from '../../pos-web/src/lib/api';
import { nativeFetch } from './native-fetch';
import './styles.css';

const api = createApiClient(nativeFetch);
const root = document.getElementById('root');
if (root === null) throw new Error('Korvi Cashier root element is missing.');

createRoot(root).render(
  <StrictMode>
    <PosApp api={api} />
  </StrictMode>,
);
