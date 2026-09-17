import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { PosApp } from '../../pos-web/src/components/pos-app';
import { createApiClient } from '../../pos-web/src/lib/api';
import { renderFiscalReceiptEscPos } from '../../pos-web/src/lib/fiscal-receipt-print';
import { renderPreparationTicketEscPos } from '../../pos-web/src/lib/preparation-ticket-print';
import type { FiscalReceipt, SaleSummary } from '../../pos-web/src/lib/api-types';
import type { PreparationTicket } from '../../pos-web/src/lib/preparation-ticket';
import type { OfflineStoreProtector } from '../../pos-web/src/lib/offline-protection';
import {
  verifyInstalledOfflineAuthority,
  type InstalledDeviceStatus,
  type NativeOfflineAuthorityMaterial,
} from './installed-offline-authority';
import { nativeFetch } from './native-fetch';
import '../../pos-web/src/app/globals.css';

const api = createApiClient(nativeFetch);

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToUtf8(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function nativeLocalStoreProtector(
  status: InstalledDeviceStatus,
): OfflineStoreProtector | undefined {
  if (status.binding === null) return undefined;
  return {
    installationId: status.installationId,
    deviceEnrollmentId: status.binding.deviceEnrollmentId,
    async protect(plaintextUtf8, aadUtf8) {
      return invoke<string>('protect_local_store', {
        plaintextBase64: utf8ToBase64(plaintextUtf8),
        aadBase64: utf8ToBase64(aadUtf8),
      });
    },
    async unprotect(ciphertextBase64, aadUtf8) {
      const plaintextBase64 = await invoke<string>('unprotect_local_store', {
        protectedBase64: ciphertextBase64,
        aadBase64: utf8ToBase64(aadUtf8),
      });
      return base64ToUtf8(plaintextBase64);
    },
  };
}

function receiptPrinterStorageKey(deviceEnrollmentId: string): string {
  return `korvi.cashier.receipt-printer.${deviceEnrollmentId}`;
}

function prepPrinterStorageKey(deviceEnrollmentId: string): string {
  return `korvi.cashier.prep-printer.${deviceEnrollmentId}`;
}

function InstalledCashier(): React.JSX.Element {
  const [status, setStatus] = useState<InstalledDeviceStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState('');
  const [enrollmentId, setEnrollmentId] = useState('');
  const [printerHost, setPrinterHost] = useState<string | null>(null);
  const [printerHostDraft, setPrinterHostDraft] = useState('');
  const [prepPrinterHost, setPrepPrinterHost] = useState<string | null>(null);
  const [prepPrinterHostDraft, setPrepPrinterHostDraft] = useState('');
  const [editingPrinter, setEditingPrinter] = useState(false);
  const offlineStoreProtector = useMemo(
    () => (status === null ? undefined : nativeLocalStoreProtector(status)),
    [status],
  );

  const load = async () => {
    try {
      const nextStatus = await invoke<InstalledDeviceStatus>('device_status');
      setStatus(nextStatus);
      if (nextStatus.binding !== null) {
        const savedHost = localStorage
          .getItem(receiptPrinterStorageKey(nextStatus.binding.deviceEnrollmentId))
          ?.trim();
        const normalizedHost = savedHost === undefined || savedHost === '' ? null : savedHost;
        const savedPrepHost = localStorage
          .getItem(prepPrinterStorageKey(nextStatus.binding.deviceEnrollmentId))
          ?.trim();
        const normalizedPrepHost =
          savedPrepHost === undefined || savedPrepHost === '' ? null : savedPrepHost;
        setPrinterHost(normalizedHost);
        setPrinterHostDraft(normalizedHost ?? '');
        setPrepPrinterHost(normalizedPrepHost);
        setPrepPrinterHostDraft(normalizedPrepHost ?? '');
      }
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

  const printFiscalReceipt = useCallback(
    async (sale: SaleSummary, receipt: FiscalReceipt): Promise<void> => {
      if (printerHost === null) throw new Error('receipt printer is not configured');
      const job = renderFiscalReceiptEscPos(sale, receipt);
      await invoke<void>('print_tcp_escpos', {
        host: printerHost,
        payload: job.payload,
      });
    },
    [printerHost],
  );

  const printPreparationTicket = useCallback(
    async (ticket: PreparationTicket): Promise<void> => {
      if (prepPrinterHost === null) throw new Error('preparation printer is not configured');
      const job = renderPreparationTicketEscPos(ticket);
      await invoke<void>('print_tcp_escpos', {
        host: prepPrinterHost,
        payload: job.payload,
      });
    },
    [prepPrinterHost],
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

  if (printerHost === null || editingPrinter) {
    return (
      <main dir="rtl" className="mx-auto min-h-screen max-w-2xl bg-background p-8 text-foreground">
        <h1 className="text-2xl font-bold">إعداد الطابعات</h1>
        <p className="mt-3 text-sm text-muted-foreground">
          أدخل عنوان طابعة ESC/POS المحلية على الشبكة. يستخدم كورفي TCP/9100 ويرفض الوجهات غير
          المحلية. الطباعة لا تغيّر البيع أو الفاتورة الضريبية.
        </p>
        <label className="mt-6 block text-sm font-medium">
          عنوان الطابعة (IP أو hostname محلي)
          <input
            className="mt-2 w-full rounded-lg border bg-background p-3 text-start"
            dir="ltr"
            placeholder="192.168.1.50"
            value={printerHostDraft}
            onChange={(event) => setPrinterHostDraft(event.target.value)}
          />
        </label>
        <label className="mt-4 block text-sm font-medium">
          عنوان طابعة التحضير (اختياري ومستقل)
          <input
            className="mt-2 w-full rounded-lg border bg-background p-3 text-start"
            dir="ltr"
            placeholder="192.168.1.60"
            value={prepPrinterHostDraft}
            onChange={(event) => setPrepPrinterHostDraft(event.target.value)}
          />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">
          تذكرة التحضير تشغيلية وغير ضريبية، وتستخدم مسار طابعة منفصل عن فاتورة العميل.
        </p>
        <div className="mt-6 flex gap-3">
          <button
            className="rounded-lg bg-emerald-700 px-5 py-3 font-semibold text-white disabled:opacity-50"
            disabled={printerHostDraft.trim() === ''}
            onClick={() => {
              const nextHost = printerHostDraft.trim();
              localStorage.setItem(
                receiptPrinterStorageKey(status.binding!.deviceEnrollmentId),
                nextHost,
              );
              const nextPrepHost = prepPrinterHostDraft.trim();
              if (nextPrepHost === '') {
                localStorage.removeItem(prepPrinterStorageKey(status.binding!.deviceEnrollmentId));
                setPrepPrinterHost(null);
              } else {
                localStorage.setItem(
                  prepPrinterStorageKey(status.binding!.deviceEnrollmentId),
                  nextPrepHost,
                );
                setPrepPrinterHost(nextPrepHost);
              }
              setPrinterHost(nextHost);
              setEditingPrinter(false);
            }}
          >
            حفظ الطابعة
          </button>
          {printerHost !== null ? (
            <button
              className="rounded-lg border px-5 py-3 font-semibold"
              onClick={() => {
                setPrinterHostDraft(printerHost);
                setPrepPrinterHostDraft(prepPrinterHost ?? '');
                setEditingPrinter(false);
              }}
            >
              إلغاء
            </button>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <div className="relative h-screen">
      <PosApp
        api={api}
        authorizeOfflineWorkspace={authorizeOfflineWorkspace}
        offlineWorkspaceMaxAgeMs={null}
        offlineStoreDeviceEnrollmentId={status.binding.deviceEnrollmentId}
        offlineStoreProtector={offlineStoreProtector}
        printFiscalReceipt={printFiscalReceipt}
        printPreparationTicket={printPreparationTicket}
      />
      <button
        className="fixed bottom-2 start-2 z-50 rounded-md border bg-background/95 px-3 py-2 text-xs font-semibold shadow-sm"
        onClick={() => {
          setPrinterHostDraft(printerHost);
          setPrepPrinterHostDraft(prepPrinterHost ?? '');
          setEditingPrinter(true);
        }}
      >
        إعداد الطابعة
      </button>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <InstalledCashier />
  </React.StrictMode>,
);
