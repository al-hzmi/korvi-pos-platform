'use client';

import { useReducer } from 'react';
import { cartReducer } from '../lib/cart';
import type { CartAction, CartLine } from '../lib/cart';

export interface CartHandle {
  readonly lines: readonly CartLine[];
  readonly dispatch: (action: CartAction) => void;
}

export function useCart(): CartHandle {
  const [lines, dispatch] = useReducer(cartReducer, [] as readonly CartLine[]);
  return { lines, dispatch };
}
