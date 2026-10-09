'use client';

import { useMemo } from 'react';
import { PosApp } from './pos-app';
import { createApiClient } from '../lib/api';
import type { JSX } from 'react';

export interface WebPosAppProps {
  readonly onManagementLanding?: (() => void) | undefined;
  readonly controlCentreHref?: string | undefined;
}

/**
 * Browser-only composition root for the till.
 *
 * PosApp owns the cashier state machine but does not choose a transport. The
 * browser host is the only place that binds the same-origin HttpOnly-cookie
 * client. Installed Cashier will inject its native transport instead.
 */
export function WebPosApp({
  onManagementLanding,
  controlCentreHref,
}: WebPosAppProps = {}): JSX.Element {
  const api = useMemo(() => createApiClient(), []);

  return (
    <PosApp
      api={api}
      onManagementLanding={onManagementLanding}
      controlCentreHref={controlCentreHref}
    />
  );
}
