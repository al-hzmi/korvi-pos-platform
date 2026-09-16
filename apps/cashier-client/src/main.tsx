import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { PosApp } from '../../pos-web/src/components/pos-app';
import { createApiClient } from '../../pos-web/src/lib/api';
import {
  verifyInstalledOfflineAuthority,
  type InstalledDeviceStatus,
  type NativeOfflineAuthorityMaterial,
} from './installed-offline-authority';
import { nativeFetch } from './native-fetch';
import '../../pos-web/src/app/globals.css';

const api = createApiClient(nativeFetch);

function InstalledCashier(): React.JSX.Element {
  const [status, setStatus] = useState<InstalledDeviceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState('');
  const [enrollmentId, setEnrollmentId] = useState('');

  const load = async () => {
    try {
      setStatus(await invoke<InstalledDeviceStatus>('device_status'));
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const authorizeOfflineWorkspace = useCallback(
    async (snapshot: Parameters<typeof verifyInstalledOfflineAuthority>[2]): Promise<boolean> => {
      if (status?.binding === null || status === null) return false;
      try {
        const material = await invoke<NativeOfflineAuthorityMaterial>('offline_authority_material');
        const authority = await verifyInstalledOfflineAuthority(material, status, snapshot);
        return (
          authority !== null && authority.deviceEnrollmentId === status.binding.deviceEnrollmentId
        );
      } catch {
        return false;
      }
    },
    [status],
  );

  if (error !== null)
    return (
      <main dir="rtl" className="min-h-screen bg-background p-8 text-foreground">
        <h1 className="text-2xl font-bold">تعذر فتح هوية جهاز كورفي</h1>
        <p className="mt-4">{error}</p>
      </main>
    );
  if (status === null)
    return (
      <main dir="rtl" className="min-h-screen bg-background p-8 text-foreground">
        جارٍ تهيئة هوية الجهاز…
      </main>
    );
  if (status.binding === null) {
    return (
      <main dir="rtl" className="mx-auto min-h-screen max-w-3xl bg-background p-8 text-foreground">
        <h1 className="text-2xl font-bold">ربط جهاز كاشير كورفي</h1>
        <p className="mt-3 text-sm">
          أنشئ Device Enrollment من Platform Admin باستخدام البيانات العامة التالية. المفتاح الخاص
          لا يغادر نظام التشغيل.
        </p>
        <dl className="mt-6 grid gap-3 rounded-xl border p-5 text-sm">
          <div>
            <dt className="font-semibold">Installation ID</dt>
            <dd className="break-all">{status.installationId}</dd>
          </div>
          <div>
            <dt className="font-semibold">Public key SHA-256</dt>
            <dd className="break-all">{status.publicKeySha256}</dd>
          </div>
          <div>
            <dt className="font-semibold">Public key SPKI (Base64)</dt>
            <dd className="break-all">{status.publicKeySpki}</dd>
          </div>
          <div>
            <dt className="font-semibold">الحفظ</dt>
            <dd>{status.custody}</dd>
          </div>
        </dl>
        <label className="mt-6 block text-sm font-medium">
          Tenant ID
          <input
            className="mt-2 w-full rounded-lg border bg-background p-3"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
          />
        </label>
        <label className="mt-4 block text-sm font-medium">
          Device Enrollment ID
          <input
            className="mt-2 w-full rounded-lg border bg-background p-3"
            value={enrollmentId}
            onChange={(e) => setEnrollmentId(e.target.value)}
          />
        </label>
        <button
          className="mt-6 rounded-lg bg-emerald-700 px-5 py-3 font-semibold text-white"
          onClick={() =>
            void invoke('bind_device', { tenantId, deviceEnrollmentId: enrollmentId })
              .then(load)
              .catch((cause) => setError(String(cause)))
          }
        >
          ربط الجهاز
        </button>
      </main>
    );
  }
  return (
    <PosApp
      api={api}
      authorizeOfflineWorkspace={authorizeOfflineWorkspace}
      offlineWorkspaceMaxAgeMs={null}
      offlineStoreDeviceEnrollmentId={status.binding.deviceEnrollmentId}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <InstalledCashier />
  </React.StrictMode>,
);
