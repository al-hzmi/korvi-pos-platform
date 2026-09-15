'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { PosApp } from './pos-app';
import type { JSX } from 'react';

/**
 * Browser-only merchant host.
 *
 * Next owns product routing. The reusable cashier runtime only knows that a
 * host may hand a management principal elsewhere; it does not know the Control
 * route and installed Cashier never receives this capability.
 */
export function MerchantEntry(): JSX.Element {
  const router = useRouter();
  const openControl = useCallback(() => {
    router.replace('/control');
  }, [router]);

  return <PosApp onManagementLanding={openControl} controlCentreHref="/control" />;
}
