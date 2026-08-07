import { KorviMark, Numeric, CardSurface, Button, BidiIsolate } from '@korvi/ui';
import {
  VAT_STANDARD_BP,
  allocateEvenly,
  grossFromNet,
  moneyFromMajorString,
  moneyToMajorString,
  taxFromNet,
} from '@korvi/domain';

/**
 * Foundation smoke page.
 *
 * It exists to prove the wiring end to end — tokens, fonts, RTL, the wordmark,
 * and the domain core computing real figures inside a rendered page. It is not
 * the cashier screen; that is Phase 1.
 */
export default function Home(): React.JSX.Element {
  const net = moneyFromMajorString('100.00');
  const vat = taxFromNet(net, VAT_STANDARD_BP);
  const gross = grossFromNet(net, VAT_STANDARD_BP);
  const split = allocateEvenly(gross, 3);

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <KorviMark size="lg" />
        <span className="text-xs text-muted-foreground">المرحلة صفر — الأساس</span>
      </header>

      <CardSurface className="p-6">
        <h1 className="mb-4 text-2xl font-semibold">التحقق من النواة المالية</h1>

        <dl className="flex flex-col gap-2 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">الإجمالي قبل الضريبة</dt>
            <dd>
              <Numeric value={moneyToMajorString(net)} />
            </dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-muted-foreground">ضريبة القيمة المضافة (15%)</dt>
            <dd>
              <Numeric value={moneyToMajorString(vat)} />
            </dd>
          </div>
          <div className="flex items-center justify-between border-t border-border pt-2 font-semibold">
            <dt>الإجمالي</dt>
            <dd>
              <Numeric value={moneyToMajorString(gross)} className="text-lg" />
            </dd>
          </div>
        </dl>
      </CardSurface>

      <CardSurface className="p-6">
        <h2 className="mb-2 text-lg font-semibold">التقسيم على ثلاثة</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          مجموع الأنصبة يساوي الإجمالي تماماً — لا هللة تُفقد ولا تُخلق.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {split.map((part, index) => (
            <li key={index} className="flex items-center justify-between">
              <span className="text-muted-foreground">
                الجزء <BidiIsolate>{String(index + 1)}</BidiIsolate>
              </span>
              <Numeric value={moneyToMajorString(part)} />
            </li>
          ))}
        </ul>
      </CardSurface>

      <div className="flex flex-wrap gap-3">
        <Button size="lg">زر الدفع</Button>
        <Button variant="secondary">ثانوي</Button>
        <Button variant="outline">محدد</Button>
        <Button variant="destructive">إلغاء</Button>
        <Button loading>قيد التنفيذ</Button>
      </div>
    </main>
  );
}
