'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { WebPosApp } from './web-pos-app';
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

  return <WebPosApp onManagementLanding={openControl} controlCentreHref="/control" />;
}
