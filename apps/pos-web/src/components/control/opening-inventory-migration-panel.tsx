'use client';

import { useMemo, useState } from 'react';
import { newId } from '@korvi/domain';
import { Button, CardSurface } from '@korvi/ui';
import { StatusNote } from '../status-note';
import { ApiError } from '../../lib/api';
import {
  migrationCellText,
  openingInventoryMigrationMappingProblems,
  OPENING_INVENTORY_MIGRATION_FIELD_LABELS,
  OPENING_INVENTORY_MIGRATION_TEMPLATE_CSV,
  openingInventoryMigrationProblemsCsv,
} from '../../lib/migration';
import type { JSX } from 'react';
import type { ApiClient } from '../../lib/api';
import type {
  CsvOpeningInventoryMigrationSource,
  OpeningInventoryMigrationInspection,
  OpeningInventoryMigrationMapping,
  OpeningInventoryMigrationRowResult,
  OpeningInventoryMigrationSummary,
  OpeningInventoryMigrationTargetField,
  XlsxOpeningInventoryMigrationSource,
} from '../../lib/api-types';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const ALL_FIELDS = Object.keys(OPENING_INVENTORY_MIGRATION_FIELD_LABELS) as OpeningInventoryMigrationTargetField[];

type PreparedSource =
  | { readonly format: 'csv'; readonly value: CsvOpeningInventoryMigrationSource }
  | { readonly format: 'xlsx'; readonly value: XlsxOpeningInventoryMigrationSource };

type PendingCommand =
  | { readonly kind: 'create'; readonly operationId: string }
  | { readonly kind: 'dry-run' }
  | { readonly kind: 'commit'; readonly operationId: string };

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.serverMessage !== null) return error.serverMessage;
    if (error.ambiguous) {
      return 'لم يصل تأكيد من الخادم. لا تغيّر الملف أو الربط؛ أعد نفس العملية حتى يُحسم وضعها.';
    }
    if (error.forbidden) return 'لا تملك الصلاحية المطلوبة لهذه العملية.';
    return 'رفض الخادم العملية: ' + error.code;
  }
  return 'تعذر تنفيذ عملية الترحيل.';
}

function fileFormat(file: File): 'csv' | 'xlsx' | null {
  const lower = file.name.toLocaleLowerCase('en-US');
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function downloadText(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function rowTone(classification: OpeningInventoryMigrationRowResult['classification']): string {
  if (classification === 'BLOCKED' || classification === 'ERROR') return 'text-destructive';
  if (classification === 'WARNING') return 'text-amber-700';
  return 'text-foreground';
}

export function OpeningInventoryMigrationPanel({
  api,
  canCommit,
  disabled = false,
  onCommandLockChange,
}: {
  readonly api: ApiClient;
  readonly canCommit: boolean;
  readonly disabled?: boolean;
  readonly onCommandLockChange: (locked: boolean) => void;
}): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [delimiter, setDelimiter] = useState<',' | ';' | '\t'>(',');
  const [sourceSystem, setSourceSystem] = useState('');
  const [prepared, setPrepared] = useState<PreparedSource | null>(null);
  const [inspection, setInspection] = useState<OpeningInventoryMigrationInspection | null>(null);
  const [mapping, setMapping] = useState<readonly OpeningInventoryMigrationMapping[]>([]);
  const [job, setJob] = useState<OpeningInventoryMigrationSummary | null>(null);
  const [problemRows, setProblemRows] = useState<readonly OpeningInventoryMigrationRowResult[]>([]);
  const [busy, setBusy] = useState<
    'idle' | 'inspect' | 'create' | 'dry-run' | 'commit' | 'problems' | 'export'
  >('idle');
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mappingProblems = useMemo(() => openingInventoryMigrationMappingProblems(mapping), [mapping]);
  const selectedFormat = file === null ? null : fileFormat(file);
  const commandLocked =
    disabled || busy === 'create' || busy === 'dry-run' || busy === 'commit' || pending !== null;

  const resetFromFile = (nextFile: File | null): void => {
    setFile(nextFile);
    setPrepared(null);
    setInspection(null);
    setMapping([]);
    setJob(null);
    setProblemRows([]);
    setPending(null);
    setFailure(null);
    setNotice(null);
    onCommandLockChange(false);
  };

  const inspect = async (): Promise<void> => {
    if (file === null) {
      setFailure('اختر ملف CSV أو XLSX أولاً.');
      return;
    }
    const format = fileFormat(file);
    if (format === null) {
      setFailure('الملف يجب أن يكون CSV أو XLSX.');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFailure('حجم الملف يتجاوز الحد الحالي 5 ميجابايت.');
      return;
    }

    setBusy('inspect');
    setFailure(null);
    setNotice(null);
    try {
      let nextPrepared: PreparedSource;
      let result: OpeningInventoryMigrationInspection;
      if (format === 'csv') {
        const value: CsvOpeningInventoryMigrationSource = {
          csvText: await file.text(),
          fileName: file.name,
          sourceSystem: sourceSystem.trim() === '' ? null : sourceSystem.trim(),
          delimiter,
        };
        nextPrepared = { format, value };
        result = await api.inspectOpeningInventoryMigrationCsv(value);
      } else {
        const value: XlsxOpeningInventoryMigrationSource = {
          xlsxBase64: arrayBufferToBase64(await file.arrayBuffer()),
          fileName: file.name,
          sourceSystem: sourceSystem.trim() === '' ? null : sourceSystem.trim(),
        };
        nextPrepared = { format, value };
        result = await api.inspectOpeningInventoryMigrationXlsx(value);
      }
      setPrepared(nextPrepared);
      setInspection(result);
      setMapping(
        result.header.map((column) => ({
          sourceColumn: column.sourceColumn,
          targetField: column.targetField,
        })),
      );
      setJob(null);
      setProblemRows([]);
      setNotice(
        'تم فحص الملف دون كتابة بيانات. راجع ربط الأعمدة والمعاينة قبل إنشاء مهمة الترحيل.',
      );
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy('idle');
    }
  };

  async function loadProblems(jobId: string): Promise<void> {
    setBusy('problems');
    try {
      const page = await api.openingInventoryMigrationRows(jobId, {
        limit: 200,
        problemsOnly: true,
      });
      setProblemRows(page.rows);
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy('idle');
    }
  }

  const executeCreate = async (operationId: string): Promise<void> => {
    if (prepared === null || inspection === null || mappingProblems.length > 0) return;
    setBusy('create');
    setFailure(null);
    setNotice(null);
    onCommandLockChange(true);
    try {
      const result =
        prepared.format === 'csv'
          ? await api.createOpeningInventoryMigrationCsvJob({
              ...prepared.value,
              operationId,
              mapping,
            })
          : await api.createOpeningInventoryMigrationXlsxJob({
              ...prepared.value,
              operationId,
              mapping,
            });
      setJob(result);
      setPending(null);
      setNotice('أُنشئت مراجعة قابلة للتتبع. لم يُكتب أي رصيد مخزون بعد.');
      onCommandLockChange(false);
    } catch (error) {
      if (error instanceof ApiError && error.ambiguous) {
        setPending({ kind: 'create', operationId });
      } else {
        setPending(null);
        onCommandLockChange(false);
      }
      setFailure(errorMessage(error));
    } finally {
      setBusy('idle');
    }
  };

  const executeDryRun = async (): Promise<void> => {
    if (job === null) return;
    setBusy('dry-run');
    setFailure(null);
    setNotice(null);
    onCommandLockChange(true);
    try {
      const result = await api.dryRunOpeningInventoryMigration(job.id);
      setJob(result);
      setPending(null);
      setNotice(
        'اكتمل الفحص التجريبي دون تغيير المخزون. سيتم رفض أي صف لا يخص رصيدًا صفريًا بكرًا داخل الفرع المحدد.',
      );
      onCommandLockChange(false);
      await loadProblems(result.id);
    } catch (error) {
      if (error instanceof ApiError && error.ambiguous) {
        setPending({ kind: 'dry-run' });
      } else {
        setPending(null);
        onCommandLockChange(false);
      }
      setFailure(errorMessage(error));
    } finally {
      setBusy('idle');
    }
  };

  const executeCommit = async (operationId: string): Promise<void> => {
    if (job === null || !canCommit) return;
    setBusy('commit');
    setFailure(null);
    setNotice(null);
    onCommandLockChange(true);
    try {
      const result = await api.commitOpeningInventoryMigration(job.id, operationId);
      setJob(result);
      setPending(null);
      setNotice('اكتمل الاستيراد. كُتبت حركات رصيد افتتاحي سببية بتكلفة غير معروفة؛ النتائج أدناه هي الحقيقة المسجلة للخادم.');
      onCommandLockChange(false);
      await loadProblems(result.id);
    } catch (error) {
      if (error instanceof ApiError && error.ambiguous) {
        setPending({ kind: 'commit', operationId });
      } else {
        setPending(null);
        onCommandLockChange(false);
      }
      setFailure(errorMessage(error));
    } finally {
      setBusy('idle');
    }
  };

  const retryPending = async (): Promise<void> => {
    if (pending === null) return;
    if (pending.kind === 'create') {
      await executeCreate(pending.operationId);
      return;
    }
    if (pending.kind === 'dry-run') {
      await executeDryRun();
      return;
    }
    await executeCommit(pending.operationId);
  };

  const exportProblems = async (): Promise<void> => {
    if (job === null) return;
    setBusy('export');
    setFailure(null);
    try {
      const rows: OpeningInventoryMigrationRowResult[] = [];
      let after: number | null = null;
      for (let pageNumber = 0; pageNumber < 200; pageNumber += 1) {
        const page = await api.openingInventoryMigrationRows(job.id, {
          limit: 500,
          afterSourceRow: after,
          problemsOnly: true,
        });
        rows.push(...page.rows);
        if (page.nextAfterSourceRow === null) break;
        after = page.nextAfterSourceRow;
        if (pageNumber === 199) throw new Error('Too many migration error pages.');
      }
      downloadText('korvi-opening-inventory-import-errors.csv', openingInventoryMigrationProblemsCsv(rows));
      setNotice('تم تجهيز ملف الأخطاء من النتائج المسجلة للخادم.');
    } catch (error) {
      setFailure(errorMessage(error));
    } finally {
      setBusy('idle');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <CardSurface className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">استيراد الرصيد الافتتاحي</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              الملف يمر بالفحص والربط والمعاينة والفحص التجريبي قبل أي حركة مخزون فعلية. الربط يعتمد على كود الفرع وSKU فقط، والتكلفة تبقى غير معروفة.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={commandLocked}
            onClick={() =>
              downloadText('korvi-opening-inventory-template.csv', OPENING_INVENTORY_MIGRATION_TEMPLATE_CSV)
            }
          >
            قالب الرصيد الافتتاحي CSV
          </Button>
        </div>

        {failure === null ? null : (
          <div className="mt-4">
            <StatusNote tone="danger" live>
              {failure}
            </StatusNote>
          </div>
        )}
        {notice === null ? null : (
          <div className="mt-4">
            <StatusNote tone="success" live>
              {notice}
            </StatusNote>
          </div>
        )}
        {pending === null ? null : (
          <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="text-sm text-amber-900">
              العملية غير محسومة. يجب إعادة نفس العملية بهويتها نفسها، لا إنشاء عملية جديدة.
            </p>
            <Button className="mt-3" variant="outline" onClick={() => void retryPending()}>
              إعادة نفس العملية
            </Button>
          </div>
        )}

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="flex flex-col gap-2 text-sm font-medium text-foreground md:col-span-2">
            ملف الرصيد الافتتاحي
            <input
              type="file"
              accept=".csv,.xlsx"
              disabled={commandLocked}
              onChange={(event) => resetFromFile(event.currentTarget.files?.[0] ?? null)}
              className="h-touch rounded-md border border-input bg-background px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
            النظام المصدر — اختياري
            <input
              value={sourceSystem}
              disabled={commandLocked}
              onChange={(event) => {
                setSourceSystem(event.target.value);
                setPrepared(null);
                setInspection(null);
                setJob(null);
              }}
              placeholder="مثال: النظام السابق"
              className="h-touch rounded-md border border-input bg-background px-3"
            />
          </label>
          {selectedFormat === 'csv' ? (
            <label className="flex flex-col gap-2 text-sm font-medium text-foreground">
              فاصل CSV
              <select
                value={delimiter}
                disabled={commandLocked}
                onChange={(event) => {
                  const value = event.target.value;
                  setDelimiter(value === ';' ? ';' : value === '\t' ? '\t' : ',');
                  setPrepared(null);
                  setInspection(null);
                  setJob(null);
                }}
                className="h-touch rounded-md border border-input bg-background px-3"
              >
                <option value=",">فاصلة ,</option>
                <option value=";">فاصلة منقوطة ;</option>
                <option value={'\t'}>Tab</option>
              </select>
            </label>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            loading={busy === 'inspect'}
            disabled={file === null || commandLocked}
            onClick={() => void inspect()}
          >
            فحص الملف
          </Button>
        </div>
      </CardSurface>

      {inspection === null ? null : (
        <>
          <CardSurface className="p-5">
            <h3 className="font-semibold text-foreground">ربط الأعمدة</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              الاقتراح تلقائي وحتمي من أسماء الأعمدة. تستطيع تعديله قبل إنشاء المهمة.
            </p>

            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[42rem] text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-3 py-2 text-start">عمود المصدر</th>
                    <th className="px-3 py-2 text-start">حقل Korvi</th>
                    <th className="px-3 py-2 text-start">الاكتشاف</th>
                  </tr>
                </thead>
                <tbody>
                  {inspection.header.map((column) => (
                    <tr key={column.sourceColumn} className="border-b border-border">
                      <td className="px-3 py-3">
                        {column.sourceHeader === ''
                          ? 'عمود ' + String(column.sourceColumn + 1)
                          : column.sourceHeader}
                      </td>
                      <td className="px-3 py-3">
                        <select
                          value={
                            mapping.find((item) => item.sourceColumn === column.sourceColumn)
                              ?.targetField ?? ''
                          }
                          disabled={commandLocked}
                          onChange={(event) => {
                            const value = event.target.value as OpeningInventoryMigrationTargetField | '';
                            setMapping((current) =>
                              current.map((item) =>
                                item.sourceColumn === column.sourceColumn
                                  ? { ...item, targetField: value === '' ? null : value }
                                  : item,
                              ),
                            );
                          }}
                          className="h-touch w-full rounded-md border border-input bg-background px-2"
                        >
                          <option value="">غير مربوط</option>
                          {ALL_FIELDS.map((field) => (
                            <option key={field} value={field}>
                              {OPENING_INVENTORY_MIGRATION_FIELD_LABELS[field]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">
                        {column.reason === 'exact-alias' ? 'مطابقة معروفة' : 'يتطلب مراجعة'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {mappingProblems.length === 0 ? (
              <StatusNote tone="success" className="mt-4">
                الحقول الإلزامية مربوطة بلا تكرار.
              </StatusNote>
            ) : (
              <div className="mt-4 space-y-2">
                {mappingProblems.map((problem, index) => (
                  <StatusNote key={problem.code + '-' + String(index)} tone="warning">
                    {problem.message}
                  </StatusNote>
                ))}
              </div>
            )}

            <div className="mt-4 flex justify-end">
              <Button
                disabled={commandLocked || mappingProblems.length > 0}
                loading={busy === 'create'}
                onClick={() => void executeCreate(newId())}
              >
                إنشاء مراجعة الترحيل
              </Button>
            </div>
          </CardSurface>

          <CardSurface className="overflow-x-auto">
            <div className="p-5 pb-2">
              <h3 className="font-semibold text-foreground">معاينة المصدر</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {inspection.totalRows} صف بيانات · المعروض أول {inspection.previewRows.length} صف
                فقط.
              </p>
            </div>
            <table className="min-w-full text-xs">
              <tbody>
                {inspection.previewRows.map((row) => (
                  <tr key={row.sourceRow} className="border-t border-border">
                    <th className="px-3 py-2 text-start font-medium">{row.sourceRow}</th>
                    {row.cells.map((cell, index) => (
                      <td key={index} className="max-w-56 truncate px-3 py-2">
                        {migrationCellText(cell) || '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </CardSurface>
        </>
      )}

      {job === null ? null : (
        <CardSurface className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold text-foreground">نتيجة مهمة ترحيل الأرصدة مخزون</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {job.id} · {job.status}
              </p>
            </div>
            <Button
              variant="outline"
              disabled={busy !== 'idle'}
              onClick={() => void loadProblems(job.id)}
            >
              تحديث الأخطاء
            </Button>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
            {[
              ['الإجمالي', job.totalRows],
              ['صالح', job.validRows],
              ['تحذير', job.warningRows],
              ['خطأ', job.errorRows],
              ['محظور', job.blockedRows],
              ['أُنشئ', job.created],
              ['فشل', job.failed + job.rejected],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-md border border-border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-1 text-lg font-semibold">{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {job.status === 'reviewed' ? (
              <Button
                variant="secondary"
                loading={busy === 'dry-run'}
                disabled={commandLocked}
                onClick={() => void executeDryRun()}
              >
                تشغيل Dry Run
              </Button>
            ) : null}
            {job.status === 'dry-run' ? (
              canCommit ? (
                <Button
                  loading={busy === 'commit'}
                  disabled={commandLocked}
                  onClick={() => void executeCommit(newId())}
                >
                  اعتماد الاستيراد
                </Button>
              ) : (
                <StatusNote tone="warning">
                  الاعتماد يحتاج صلاحية إدارة المشتريات، بينما الفحص والمراجعة متاحان لك.
                </StatusNote>
              )
            ) : null}
            <Button
              variant="outline"
              disabled={busy !== 'idle'}
              onClick={() => void exportProblems()}
            >
              تصدير الأخطاء CSV
            </Button>
          </div>

          {problemRows.length === 0 ? null : (
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[44rem] text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="px-3 py-2 text-start">الصف</th>
                    <th className="px-3 py-2 text-start">المعرف</th>
                    <th className="px-3 py-2 text-start">الحالة</th>
                    <th className="px-3 py-2 text-start">السبب</th>
                  </tr>
                </thead>
                <tbody>
                  {problemRows.map((row) => (
                    <tr
                      key={String(row.sourceRow) + '-' + (row.sourceIdentifier ?? '')}
                      className="border-b border-border"
                    >
                      <td className="px-3 py-3">{row.sourceRow}</td>
                      <td className="px-3 py-3">{row.sourceIdentifier ?? '—'}</td>
                      <td className={'px-3 py-3 font-medium ' + rowTone(row.classification)}>
                        {row.classification}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">
                        {row.issues.map((issue) => issue.message).join(' · ') ||
                          row.errorCode ||
                          '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardSurface>
      )}
    </div>
  );
}
