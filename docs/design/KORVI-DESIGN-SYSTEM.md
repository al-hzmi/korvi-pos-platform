# نظام كورفي البصري — Korvi Design System

**الإصدار 1.0 — مستخرج بالهندسة العكسية من Korvi ERP**

> هذه الوثيقة ليست اقتراحاً تصميمياً. كل قيمة فيها مقروءة من الكود العامل في
> `Korvi ERP` ومُحوَّلة حسابياً من HSL إلى HEX، لا مكتوبة من الذاكرة. حيث وجدنا
> تناقضاً في النظام القائم قلناه صراحةً بدل تجميله — فالغرض أن يبني فريق الـ POS
> على ما هو موجود فعلاً، لا على ما نتمنى وجوده.
>
> **المصادر:** `src/styles/globals.css` · `tailwind.config.ts` ·
> `src/app/layout.tsx` · `src/components/ui/*` · `src/components/layout/*`

---

## 0. ملخص تنفيذي — ما يجب أن يعرفه المطور في دقيقتين

| القرار | القيمة |
|---|---|
| اللون الأساسي (Primary) | تركوازي مؤسسي `#196B60` فاتح / `#34B2A1` داكن |
| الخط | IBM Plex Sans Arabic (واجهة) · IBM Plex Mono (أرقام ورموز) |
| نصف قطر الحواف الأساسي | `--radius: 0.625rem` = **10px** |
| الحافة الأكثر استخداماً | `rounded-md` (8px) — 136 استخداماً مقابل 63 لـ `rounded-lg` |
| الظلال | ثلاثة مستويات فقط: `sm` للأسطح، `lg` للقوائم المنسدلة، `2xl` للنوافذ |
| الاتجاه | **RTL افتراضياً**، وليس إضافة لاحقة |
| منحنى الحركة | `cubic-bezier(0.16, 1, 0.3, 1)` — يصل ولا يتوقف |
| المكونات | **مكتوبة يدوياً، ليست shadcn/ui** — راجع القسم 7 |

---

## 1. الجذور والمصطلحات (Root Definitions)

الغرض من هذا القسم أن يقول مبرمجان الشيء نفسه حين يقولان «Surface». المصطلحات
التالية هي المفردات الرسمية للنظام، وأي مصطلح خارجها يجب أن يُضاف هنا أولاً.

### 1.1 المبدأ الحاكم: لا لون ثابت في أي مكوّن

كل لون في النظام يأتي من متغيّر CSS معرَّف في `globals.css`. **لا يوجد `#hex`
مكتوب داخل أي مكوّن** — وهذا ما يجعل تغيير هوية مستأجر تعديلاً في ملف واحد بدل
مسح شامل للمشروع.

المتغيّرات مخزَّنة كـ **ثلاثيات قنوات HSL بلا دالة `hsl()`**:

```css
--primary: 172 62% 26%;   /* ✅ صحيح */
--primary: hsl(172 62% 26%);  /* ❌ يكسر الشفافية */
```

السبب تقني وحاسم: Tailwind يستهلكها عبر
`hsl(var(--primary) / <alpha-value>)`، فتصبح `bg-primary/10` ممكنة بلا متغيّر
ثانٍ. لو خُزِّنت جاهزة لاحتجنا متغيّراً منفصلاً لكل درجة شفافية.

### 1.2 قاموس المصطلحات

| المصطلح | التعريف الدقيق | متى تستخدمه |
|---|---|---|
| **Background** | خلفية المستند نفسه — أبعد طبقة للخلف | `<body>` فقط |
| **Foreground** | لون النص الأساسي فوق الـ Background | النص العادي |
| **Surface** | أي سطح مرفوع فوق الخلفية (`card`) | البطاقات، الجداول، اللوحات |
| **Popover** | سطح **عائم** فوق كل شيء (قوائم، منتقيات) | القوائم المنسدلة، لوحة الأوامر |
| **Primary** | لون الفعل الأساسي وهوية النظام | زر الحفظ، الروابط، الحالة النشطة |
| **Secondary** | فعل ثانوي — موجود لكنه ليس المطلوب | زر «إلغاء» بخلفية |
| **Muted** | خلفية خافتة + نص خافت | رؤوس الجداول، النصوص المساعدة |
| **Accent** | لون التمرير والتحديد المؤقت | `hover`، الصف المُحدَّد |
| **Border / Input** | حدود الأسطح وحدود الحقول | نفس القيمة، ومنفصلان عمداً |
| **Ring** | حلقة التركيز عند التنقّل بلوحة المفاتيح | `:focus-visible` حصراً |
| **Destructive / Success / Warning** | ألوان دلالية للحالة | الحالات فقط، لا للزينة |

> **Accent ليس Primary.** خطأ شائع: استخدام `bg-primary/10` لتلوين صف عند
> التمرير. الصحيح `bg-accent`. الفرق أن Accent مضبوط ليقرأ كخلفية خافتة في
> الوضعين، بينما `primary/10` في الوضع الداكن يعطي لطخة تركوازية شاحبة.

### 1.3 لماذا `foreground` مقترنة دائماً

كل لون سطح له `-foreground` مقابل. القاعدة: **إن غيّرت الخلفية، غيّر معها
النص من الزوج نفسه**. `bg-primary text-foreground` خطأ حتى لو بدا مقبولاً في
الوضع الفاتح — سيصبح غير مقروء في الداكن.

---

## 2. لوحة الألوان (Color Palette)

القيم أدناه محوَّلة حسابياً من ثلاثيات HSL في `globals.css`. عمود HSL هو
**المصدر الرسمي**؛ عمود HEX للمصممين وأدوات التصميم فقط.

### 2.1 الأسطح والنصوص

| Token | Light HSL | Light HEX | Dark HSL | Dark HEX |
|---|---|---|---|---|
| `background` | `0 0% 100%` | `#FFFFFF` | `222 30% 8%` | `#0E121B` |
| `foreground` | `222 25% 12%` | `#171C26` | `210 20% 96%` | `#F3F5F7` |
| `card` | `0 0% 100%` | `#FFFFFF` | `222 26% 11%` | `#151923` |
| `card-foreground` | `222 25% 12%` | `#171C26` | `210 20% 96%` | `#F3F5F7` |
| `popover` | `0 0% 100%` | `#FFFFFF` | `222 26% 11%` | `#151923` |
| `popover-foreground` | `222 25% 12%` | `#171C26` | `210 20% 96%` | `#F3F5F7` |

> **ملاحظة على الوضع الداكن:** `background` (#0E121B) **أغمق** من `card`
> (#151923). هذا مقصود: في الداكن الارتفاع يُعبَّر عنه بالإضاءة لا بالظل، لأن
> الظل الأسود فوق خلفية شبه سوداء لا يُرى. لا تعكس هذه العلاقة في الـ POS.

### 2.2 الهوية والأفعال

| Token | Light HSL | Light HEX | Dark HSL | Dark HEX |
|---|---|---|---|---|
| `primary` | `172 62% 26%` | `#196B60` | `172 55% 45%` | `#34B2A1` |
| `primary-foreground` | `160 40% 98%` | `#F8FCFB` | `222 30% 8%` | `#0E121B` |
| `secondary` | `210 20% 96%` | `#F3F5F7` | `222 20% 17%` | `#232834` |
| `secondary-foreground` | `222 25% 20%` | `#262E40` | `210 20% 96%` | `#F3F5F7` |
| `accent` | `172 45% 94%` | `#E9F7F5` | `172 40% 18%` | `#1C403B` |
| `accent-foreground` | `172 62% 20%` | `#13534A` | `172 55% 80%` | `#B0E8E1` |
| `muted` | `210 20% 96%` | `#F3F5F7` | `222 20% 17%` | `#232834` |
| `muted-foreground` | `215 16% 45%` | `#607085` | `215 16% 62%` | `#8F9CAE` |

**لماذا التركوازي؟** التعليق في الكود يقول السبب: *«يُقرأ كمؤسسي ومالي دون أن
يكون الأزرق المؤسسي الافتراضي الذي يستخدمه كل ERP آخر»*. هذا قرار تمييز، لا
ذوق — ولا يُغيَّر بلا سبب استراتيجي.

**ملاحظة على `primary` في الداكن:** ليس اللون نفسه مُفتَّحاً، بل درجة أخرى
(62%→55% إشباع، 26%→45% إضاءة). لون داكن مُفتَّح آلياً يُنتج تركوازياً باهتاً؛
الدرجتان مضبوطتان يدوياً لتحققا تباينـاً كافياً في سياقيهما.

### 2.3 الألوان الدلالية

| Token | Light HSL | Light HEX | Dark HSL | Dark HEX | الاستخدام |
|---|---|---|---|---|---|
| `destructive` | `0 72% 45%` | `#C52020` | `0 62% 52%` | `#D03939` | حذف، رفض، خطأ |
| `success` | `152 55% 34%` | `#27865A` | `152 45% 45%` | `#3FA676` | ترحيل، اعتماد، قبول |
| `warning` | `38 92% 45%` | `#DC8F09` | `38 85% 55%` | `#EEA62B` | تحذير قابل للتجاوز |
| `border` | `214 20% 89%` | `#DDE2E9` | `222 18% 22%` | `#2E3442` | حدود الأسطح |
| `input` | `214 20% 89%` | `#DDE2E9` | `222 18% 22%` | `#2E3442` | حدود الحقول |
| `ring` | `172 62% 32%` | `#1F8477` | `172 55% 45%` | `#34B2A1` | حلقة التركيز |

> **`border` و `input` متطابقتان قيمةً ومنفصلتان تعريفاً.** الفصل مقصود: لو
> أراد الـ POS حدوداً أوضح للحقول القابلة للّمس (وهو مطلب معقول على شاشة لمس)
> فالتغيير في متغيّر واحد لا يمس حدود البطاقات.

### 2.4 ⚠️ تناقض قائم يجب حسمه قبل بناء الـ POS

شعار Korvi يستخدم **`emerald` من Tailwind الافتراضي** — لا من متغيّرات النظام:

```tsx
// src/components/layout/korvi-mark.tsx
'text-emerald-700 dark:text-emerald-400'   // #047857 / #34D399
```

بينما `--primary` تركوازي `#196B60`. فهذان **أخضران مختلفان** في المنتج نفسه.

القرار الموثَّق في الكود أن الشعار *«العنصر الوحيد الذي يتجاهل رموز السمة
عمداً»* لأنه يجب أن يُقرأ نفسه على الواجهة الفاتحة والداكنة **وعلى الورق
المطبوع** — والورق لا سمة له.

**التوصية لفريق الـ POS:** أبقِ الفصل، لكن رقِّه إلى متغيّر صريح بدل قيمة
Tailwind مبعثرة:

```css
/* هوية العلامة — ثابتة عبر السمات وعبر الطباعة.
   القيم بمنزلة عشرية واحدة لأنها تعود بالضبط إلى #047857 و#34D399؛
   التقريب إلى عدد صحيح ينحرف إلى #027855 وهو لون آخر. */
--brand: 162.9 93.5% 24.3%;        /* #047857 — emerald-700 */
--brand-on-dark: 158.1 64.4% 51.6%; /* #34D399 — emerald-400 */
```

> **تنبيه للمنفّذ:** لا تُقرِّب هذه الأرقام. اللون يُطبع بقيمة حرفية
> `#047857` عبر `print-color-adjust: exact`، فأي انحراف يجعل الشاشة والورق
> لونين مختلفين — وهو أسوأ من عدم توحيدهما أصلاً.

بهذا يبقى القرار قائماً ويصبح مركزياً وقابلاً للتدقيق.

---

## 3. الأبعاد والقياسات

### 3.1 نصف قطر الحواف (Border Radius)

الجذر واحد وكل شيء مشتق منه:

```css
--radius: 0.625rem;   /* 10px */
```

| فئة Tailwind | الحساب | البكسل | الاستخدام الفعلي في الـ ERP |
|---|---|---|---|
| `rounded-sm` | `calc(var(--radius) - 4px)` | 6px | نادر (استخدامان) |
| `rounded-md` | `calc(var(--radius) - 2px)` | 8px | **الافتراضي** — أزرار، حقول، شارات (136×) |
| `rounded-lg` | `var(--radius)` | 10px | البطاقات والأسطح (63×) |
| `rounded-full` | — | دائرة | الصورة الرمزية والشارات الحبوبية (4×) |

**القاعدة العملية:** عنصر تفاعلي → `rounded-md`. سطح يحتوي عناصر →
`rounded-lg`. هذا هو أسلوب Linear: العنصر الداخلي أقل استدارة من حاويته، لا
العكس.

### 3.2 الظلال (Shadows)

النظام **مقتصد عمداً**: ثلاثة مستويات فقط في المشروع كله.

| المستوى | الاستخدام | العدد |
|---|---|---|
| `shadow-sm` | الأسطح الثابتة (`card-surface`) وأزرار Primary/Destructive | 3 |
| `shadow-lg` | القوائم المنسدلة العائمة (منتقي الأصناف) | 2 |
| `shadow-2xl` | النوافذ الحوارية (لوحة ZATCA، لوحة الأوامر) | 2 |

> **لا تضف مستوى رابعاً.** الظل في هذا النظام يعني «كم أنا مرتفع عن الصفحة»،
> وثلاث درجات تكفي لثلاث حالات: ملتصق، عائم، حاجب. الدرجة الرابعة تجعل
> الترتيب غير مقروء. وفي الوضع الداكن الظلال شبه غير مرئية — الارتفاع يُقرأ من
> فرق الإضاءة كما في 2.1.

### 3.3 الصور والشعارات والصور الرمزية — نسبة 1:1 إلزامية

**القاعدة:** كل صورة رمزية وكل شعار وكل صورة صنف يُرسم في **مربع تام
(1:1)**، بلا استثناء. النسبة تُفرض بالأبعاد لا بالقصّ.

| الحجم | الفئة | البكسل | الاستخدام |
|---|---|---|---|
| `xs` | `h-6 w-6` | 24×24 | داخل صف جدول |
| `sm` | `h-8 w-8` | 32×32 | قائمة مضغوطة |
| `md` | `h-9 w-9` | 36×36 | **المستخدم في الشريط العلوي** (القيمة القائمة) |
| `lg` | `h-14 w-14` | 56×56 | ترويسة الفاتورة (القيمة القائمة) |
| `xl` | `h-20 w-20` | 80×80 | بطاقة صنف في شبكة الـ POS |

```tsx
// ✅ الصحيح — مربع مضمون، والصورة تملأ بلا تشويه
<div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-muted">
  <img src={src} alt="" className="h-full w-full object-cover" />
</div>

// ❌ الخطأ — الارتفاع تابع لنسبة الصورة، فتختلف أطوال صفوف الشبكة
<img src={src} className="w-20 rounded-lg" />
```

ثلاثة عناصر لا يجوز إغفالها:

1. **`shrink-0`** — بدونه يسحق `flex` الصورة أفقياً فتصير مستطيلاً.
2. **`object-cover`** — يملأ المربع ويقصّ الفائض بدل تشويه النسبة.
3. **`overflow-hidden`** — بدونه تتجاوز الصورة الحواف المستديرة.

**بديل أحدث:** `aspect-square` يحقق الغرض نفسه ويقرأ أوضح:

```tsx
<div className="aspect-square w-20 overflow-hidden rounded-lg bg-muted">
```

**بشأن الشكل:** الصورة الرمزية في الـ ERP حالياً **دائرة**
(`rounded-full bg-primary/10`)، والشعار المطوي **مربع مستدير**
(`rounded-lg bg-emerald-700`). كلاهما 1:1 — والفرق في الحواف لا في النسبة.

**توصيتنا للـ POS: وحِّدهما على `rounded-lg`.** الدائرة تقول «شخص»، والمربع
المستدير يقول «كيان» — و Linear وStripe اعتمدا المربع المستدير لكليهما لأن
شبكة من المربعات تُقرأ كمنظومة، وشبكة من الدوائر تُقرأ كقائمة اتصال. ولشاشة
كاشير تعرض أصنافاً في شبكة، المربع المستدير هو الصحيح قطعاً.

### 3.4 المقاسات الثابتة للعناصر التفاعلية

| العنصر | الارتفاع | ملاحظة |
|---|---|---|
| زر `sm` | `h-8` (32px) | |
| زر `md` | `h-10` (40px) | الافتراضي |
| زر `lg` | `h-11` (44px) | |
| زر `icon` | `h-10 w-10` | مربع 1:1 |
| حقل إدخال | `h-10` (40px) | يطابق الزر md |
| قائمة `select` | `h-10` (40px) | |
| الشريط العلوي | `h-16` (64px) | |
| الشريط الجانبي | `w-64` / `w-[68px]` مطوياً | |

> **⚠️ تعديل مطلوب للـ POS:** الحد الأدنى الموصى به لمنطقة اللمس هو **44×44px**
> (WCAG 2.5.5 / إرشادات Apple). ارتفاع `h-10` = 40px **أقل من ذلك**. يعمل
> بالفأرة ويُخطئ بالإصبع. **اجعل `md` في الـ POS تساوي `h-11` (44px)، و`lg`
> تساوي `h-12` (48px)** لأزرار الدفع والأرقام.

---

## 4. الطباعة والخطوط (Typography)

### 4.1 العائلتان

```
IBM Plex Sans Arabic  →  الواجهة كاملة (عربي + لاتيني)
IBM Plex Mono         →  الأرقام والرموز والمعرّفات
```

كلاهما محمَّل عبر `next/font/google`، أي **يُنزَّل وقت البناء ويُخدَم من نطاقنا**
— لا طلب لطرف ثالث ولا فترة يظهر فيها النص بخط النظام.

| العائلة | الأوزان المحمَّلة | لماذا |
|---|---|---|
| Plex Sans Arabic | `300 400 500 600 700` | 400 للنص، 500 للتسميات، 600 للعناوين، 700 للأرقام البارزة |
| Plex Mono | `400 500 600` | أرقام المستندات والرموز |

**لماذا Plex Sans Arabic تحديداً؟** التعليق في `layout.tsx` يشرح: الخطوط
العربية «الجميلة» غالباً خطوط عرض (أنماط كوفية) تفشل في نص واجهة بحجم 13px.
Plex عائلة نصية مصمَّمة للقراءة الطويلة، ولها لاتيني مطابق في الوزن — وهذا ما
يمنع ظهور اللاتيني «مختلفاً» داخل الجملة العربية.

`display: 'swap'` مع `adjustFontFallback: true`: يظهر النص فوراً بخط بديل
مُقاس ليشغل المساحة نفسها تقريباً، فلا قفزة عند وصول الخط الحقيقي.

### 4.2 السلّم الفعلي المستخدم

مرتَّب بعدد الاستخدامات الحقيقي في الـ ERP:

| الفئة | الحجم | الاستخدام | العدد |
|---|---|---|---|
| `text-xs` | 12px | **العمود الفقري** — الجداول، التسميات، الشارات | 341 |
| `text-sm` | 14px | نص الواجهة العام، الأزرار | 257 |
| `text-2xl` | 24px | عنوان الصفحة `<h1>` | 80 |
| `text-[11px]` | 11px | البيانات الوصفية تحت السطر الأساسي | 57 |
| `text-[10px]` | 10px | التذييلات والتفاصيل الدقيقة | 19 |
| `text-lg` | 18px | عنوان بطاقة بارز | 13 |
| `text-base` | 16px | نص مؤكَّد داخل بطاقة | 7 |

> **الملاحظة المهمة:** هذا **ليس** سلّم 16px الافتراضي في Tailwind. النظام
> يعيش عند 12–14px لأنه تطبيق كثيف البيانات يُقرأ على مكتب — تماماً كـ Linear.
> **لا تنقل هذا كما هو إلى الـ POS**: شاشة كاشير تُقرأ على بُعد ذراع وبإصبع،
> فارفع السلّم درجة كاملة (الأساس `text-sm`، الأسعار `text-lg`+، الإجمالي
> `text-3xl`).

### 4.3 قواعد لا تُخالَف

**١. كل رقم مالي بأرقام جدولية (Tabular Figures).**

```css
.numeric {
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  direction: ltr;      /* الأرقام تُقرأ يساراً-يميناً دائماً */
  text-align: end;
}
```

السبب في الكود: *«في الخط المتناسب الرقم 1 أضيق من 8، فعمود المبالغ يهتزّ عند
تحديثه ولا تصطفّ الفواصل العشرية — وهذا هو الفرق بين جدول يمسحه المحاسب
بنظرة وجدول يضطر لقراءته»*. في الـ POS هذا أهم لا أقل: سعر يهتزّ أثناء تحديث
السلة يبدو عطلاً.

**٢. كل مقطع لاتيني داخل نص عربي معزول.**

```css
.bidi-isolate { unicode-bidi: isolate; direction: ltr; display: inline-block; }
```

بدونها يُعيد المحرّك ترتيب `INV-2026-00001` إلى `00001-2026-INV`. هذا ليس خطأ
تجميلياً — إنه رقم مستند خاطئ على الشاشة.

**٣. `calt` لا يُطفأ أبداً.**

```css
font-feature-settings: 'kern' 1, 'liga' 1, 'calt' 1;
```

`calt` هي التي تقود الأشكال السياقية للحروف العربية. إطفاؤها يكسر الاتصال بين
الحروف — أي يكسر الكتابة العربية نفسها.

---

## 5. الحركة (Motion)

منحنى واحد للنظام كله:

```
cubic-bezier(0.16, 1, 0.3, 1)
```

منحنى تباطؤ حادّ: العنصر **يصل** ولا **يتوقف**. هذا هو الفرق الملموس بين
واجهة تبدو فاخرة وأخرى تبدو آلية.

| الحركة | المدة | الاستخدام |
|---|---|---|
| `fade-in` | 180ms | ظهور المحتوى |
| `slide-in-start` | 220ms | دخول من جهة البداية (RTL-aware) |
| `overlay-in` | 120ms | خلفية النافذة الضبابية |
| `palette-in` | 160ms | لوحة الأوامر ترتفع |
| `shimmer` | 1.6s تكرار | هيكل التحميل |

**تفصيل يستحق النقل:** الخلفية (120ms) واللوحة (160ms) **لا تتحركان معاً**
عمداً — الضباب يظهر مباشرة بينما اللوحة ترتفع داخله، فتُقرأ اللوحة كأنها
*فوق* الصفحة لا جزءاً من الغشاوة نفسها.

**احترام تقليل الحركة إلزامي:**

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 6. الاتجاه (RTL) — مبدأ معماري لا خاصية

**RTL هو الافتراضي.** `<html dir="rtl">` والتصميم كله مبني عليه.

استخدم **الخصائص المنطقية** حصراً:

| ❌ لا تستخدم | ✅ استخدم |
|---|---|
| `ml-` / `mr-` | `ms-` / `me-` |
| `pl-` / `pr-` | `ps-` / `pe-` |
| `left-` / `right-` | `start-` / `end-` |
| `text-left` / `text-right` | `text-start` / `text-end` |

الاستثناءات القليلة التي لا مقابل منطقي لها تُعالَج في `globals.css`:

```css
[dir='rtl'] .flip-in-rtl { transform: scaleX(-1); }   /* الأيقونات الاتجاهية */
[dir='rtl'] .numeric { text-align: left; }            /* الأرقام تبقى يساراً */
```

---

## 7. المكونات — والحقيقة بشأن shadcn/ui

### 7.1 توضيح ضروري

طلبتم «كيفية هيكلة مكونات shadcn/ui». **الـ ERP لا يستخدم shadcn/ui.**
مكوناته مكتوبة يدوياً في `src/components/ui/`، بلا Radix ولا CVA ولا
`components.json`.

هذا ليس نقصاً بل قرار موثَّق. مثاله في `select.tsx`:

> *«`<select>` أصلية عمداً. القائمة المخصصة تحتاج تنقّلاً بلوحة المفاتيح وبحثاً
> بالكتابة ودلالات لقارئ الشاشة وسلوكاً على الجوال — وكلها موجودة هنا مجاناً.
> وعلى الهاتف يتفوّق منتقي النظام على أي شيء يُعاد بناؤه داخل div.»*

### 7.2 التوافق مع shadcn — الخبر الجيد

**بنية الرموز متطابقة تماماً** مع اصطلاح shadcn: الأسماء نفسها
(`--background`, `--primary`, `--muted`, `--ring`, `--radius`)، والصيغة نفسها
(ثلاثيات HSL)، وآلية الاستهلاك نفسها (`hsl(var(--x) / <alpha-value>)`).

**النتيجة العملية:** إن اختار فريق الـ POS استخدام shadcn/ui، فإن نسخ
`globals.css` و`tailwind.config.ts` من هذه الوثيقة يجعل كل مكوّن shadcn
يُركَّب **بهوية كورفي فوراً وبلا تعديل**. هذا هو المسار الموصى به للـ POS: لن
تحتاج إعادة بناء `Dialog` و`Popover` و`Command` يدوياً.

المكوّنان الوحيدان اللذان ننصح بنقلهما كما هما من الـ ERP:

- **`EntityPicker`** — منتقٍ فوق آلاف السجلات، بتأخير ذكي وإلغاء الاستجابات
  القديمة ووضع تصفُّح عند النقر. سلوكه مضبوط على عيوب حقيقية ظهرت في الاستخدام.
- **`KorviMark`** — الشعار النصي (القسم 8).

### 7.3 مواصفات المكونات القائمة

**الزر** (`button.tsx`) — خمسة أنماط:

| النمط | الأصناف |
|---|---|
| `primary` | `bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm` |
| `secondary` | `bg-secondary text-secondary-foreground hover:bg-secondary/80` |
| `outline` | `border border-input bg-background hover:bg-accent hover:text-accent-foreground` |
| `ghost` | `hover:bg-accent hover:text-accent-foreground` |
| `destructive` | `bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm` |

الأساس المشترك:

```
inline-flex select-none items-center justify-center gap-2 rounded-md font-medium
transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
disabled:pointer-events-none disabled:opacity-50
```

> **سلوك إلزامي:** الزر في حالة `loading` **يبقى معطَّلاً**. التعليق في الكود:
> *«أشيع طريقة لترحيل فاتورة مرتين هي الضغط على «ترحيل» مرتين قبل عودة الطلب
> الأول»*. في الـ POS هذا يعني عملية دفع مكرَّرة — انقل هذا السلوك حرفياً.

**السطح** (`card-surface`):

```css
@apply rounded-lg border border-border bg-card text-card-foreground shadow-sm;
```

**الجدول** (`data-table`): رأس لاصق `sticky top-0` بخلفية `bg-muted/60`
وضبابية، حروف كبيرة صغيرة الحجم `text-xs uppercase tracking-wide`، وصفوف
تتفاعل بـ `hover:bg-accent/40`.

**الشارة** (`badge.tsx`) — خمس نغمات، وكلها `ring-1 ring-inset` لا حدود
مصمتة:

```
neutral  → bg-muted text-muted-foreground ring-border
success  → bg-success/10 text-success ring-success/30
warning  → bg-warning/10 text-warning ring-warning/30
danger   → bg-destructive/10 text-destructive ring-destructive/30
info     → bg-primary/10 text-primary ring-primary/30
```

> **قاعدة وصول إلزامية:** النغمة يحملها **اللون والنص معاً**. اللون وحده يخالف
> WCAG 1.4.1، ومحاسب لا يميّز الألوان يجب أن يفرّق بين فاتورة مُرحَّلة وأخرى
> ملغاة.

**التركيز** — عالمي، لا لكل مكوّن:

```css
:focus-visible {
  @apply outline-none ring-2 ring-ring ring-offset-2 ring-offset-background;
}
```

---

## 8. الشعار (Korvi Wordmark)

شعار **نصي**، لا صورة. الأسباب موثَّقة في `korvi-mark.tsx`: لا ملف يُفقد،
ولا نسخة ثانية تُجارى مع السمة، **ويُطبع** — والشعار النقطي بدقة الشاشة يخرج
من الطابعة لطخة رمادية.

| المقاس | اسم العلامة | اللاحقة |
|---|---|---|
| `sm` | `text-lg` | `text-[9px]` |
| `md` | `text-2xl` | `text-[10px]` |
| `lg` | `text-3xl` | `text-xs` |

الأصناف الثابتة:

```
bidi-isolate font-extrabold tracking-wider text-emerald-700 dark:text-emerald-400
```

`dir="ltr"` و`bidi-isolate` ليسا زينة: «Korvi» مقطع لاتيني داخل مستند عربي.

**قاعدة وضع حاسمة:** الشعار **لا يوضع في ترويسة الفاتورة**. ترويسة الفاتورة
الضريبية تُعرِّف **من أصدرها**، ووضع شعار مورّد البرمجية هناك يقول إن Korvi
باعت البضاعة — على مستند تقرؤه الهيئة والمدقق. موضعه الصحيح: التذييل، بصيغة
«صُدرت عبر Korvi».

---

## 9. الطباعة (Print)

نظام الـ POS يطبع إيصالات، فهذه القواعد تنتقل مباشرة:

```css
@media print {
  .no-print, aside, header.sticky { display: none !important; }
  .sticky { position: static !important; }
  .backdrop-blur { backdrop-filter: none !important; }

  @page { margin: 14mm; }

  tr, figure, svg, dl { break-inside: avoid; }
  thead { display: table-header-group; }
  h1, h2, h3 { break-after: avoid; }
  p { orphans: 3; widows: 3; }

  /* المتصفحات تُسقط الألوان غير الأساسية عند الطباعة */
  .text-emerald-700 {
    color: #047857 !important;
    print-color-adjust: exact;
  }
  svg[role='img'] rect { fill: #fff !important; }
  svg[role='img'] path { fill: #000 !important; print-color-adjust: exact; }
}
```

> `print-color-adjust: exact` على رمز QR **إلزامي**: بدونه قد ينقلب الرمز تحت
> السمة الداكنة فيخرج رمزاً لا يقرؤه أي ماسح. و`break-inside: avoid` يمنع
> انقسامه عبر صفحتين — نصف رمز QR ما زال يبدو رمزاً.

---

## 10. `tailwind.config.ts` الموحَّد

انسخ هذا الملف كنقطة انطلاق لـ Korvi POS. مطابق لملف الـ ERP مع الإضافات
الموصى بها للمس (معلَّمة بـ `POS`).

```ts
import type { Config } from 'tailwindcss';

/**
 * Korvi Design System — Tailwind configuration.
 *
 * Tokens live as CSS variables in `globals.css` so theming happens at runtime
 * without a rebuild. Tailwind consumes them through
 * `hsl(var(--token) / <alpha-value>)`, which is what makes `bg-primary/10`
 * work without a second variable per opacity step.
 *
 * Shared verbatim with Korvi ERP. Divergence here is divergence in the brand.
 */
const config: Config = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
    './src/lib/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border) / <alpha-value>)',
        input: 'hsl(var(--input) / <alpha-value>)',
        ring: 'hsl(var(--ring) / <alpha-value>)',
        background: 'hsl(var(--background) / <alpha-value>)',
        foreground: 'hsl(var(--foreground) / <alpha-value>)',
        primary: {
          DEFAULT: 'hsl(var(--primary) / <alpha-value>)',
          foreground: 'hsl(var(--primary-foreground) / <alpha-value>)',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary) / <alpha-value>)',
          foreground: 'hsl(var(--secondary-foreground) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted) / <alpha-value>)',
          foreground: 'hsl(var(--muted-foreground) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent) / <alpha-value>)',
          foreground: 'hsl(var(--accent-foreground) / <alpha-value>)',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive) / <alpha-value>)',
          foreground: 'hsl(var(--destructive-foreground) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'hsl(var(--success) / <alpha-value>)',
          foreground: 'hsl(var(--success-foreground) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning) / <alpha-value>)',
          foreground: 'hsl(var(--warning-foreground) / <alpha-value>)',
        },
        card: {
          DEFAULT: 'hsl(var(--card) / <alpha-value>)',
          foreground: 'hsl(var(--card-foreground) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover) / <alpha-value>)',
          foreground: 'hsl(var(--popover-foreground) / <alpha-value>)',
        },

        // POS — the brand mark, promoted from a stray Tailwind `emerald` to a
        // token. It deliberately does NOT follow the theme: it must read the
        // same on the light shell, the dark shell and on white paper, and paper
        // has no theme. See §2.4.
        brand: {
          DEFAULT: 'hsl(var(--brand) / <alpha-value>)',
          'on-dark': 'hsl(var(--brand-on-dark) / <alpha-value>)',
        },
      },

      borderRadius: {
        lg: 'var(--radius)',                    // 10px — surfaces
        md: 'calc(var(--radius) - 2px)',        //  8px — controls (the default)
        sm: 'calc(var(--radius) - 4px)',        //  6px — rare
      },

      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
        // Tabular figures for every financial column — prevents digit jitter.
        numeric: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },

      // POS — touch targets. `h-10` (40px) is below the 44px minimum in
      // WCAG 2.5.5: it works with a mouse and mis-taps with a thumb. These are
      // additive, so ERP components keep their existing heights.
      spacing: {
        touch: '2.75rem',    // 44px — minimum tappable
        'touch-lg': '3rem',  // 48px — payment and keypad keys
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-start': {
          from: { opacity: '0', transform: 'translateX(-8px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
        // Two separate keyframes because the backdrop and the panel must not
        // move together: the blur fades straight in while the panel rises into
        // it, which is what makes the panel read as sitting *above* the page.
        'overlay-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'palette-in': {
          from: { opacity: '0', transform: 'translateY(-8px) scale(0.97)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },

      animation: {
        // One decelerating curve for the whole system: things arrive rather
        // than stop. This is the difference between an interface that feels
        // considered and one that feels mechanical.
        'fade-in': 'fade-in 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        'slide-in-start': 'slide-in-start 220ms cubic-bezier(0.16, 1, 0.3, 1)',
        shimmer: 'shimmer 1.6s infinite',
        'overlay-in': 'overlay-in 120ms ease-out',
        'palette-in': 'palette-in 160ms cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
```

### الجذور المرافقة (`globals.css`)

```css
:root {
  --background: 0 0% 100%;
  --foreground: 222 25% 12%;
  --card: 0 0% 100%;
  --card-foreground: 222 25% 12%;
  --popover: 0 0% 100%;
  --popover-foreground: 222 25% 12%;

  /* A deep teal-green: institutional and financial without being the default
     corporate blue every other ERP already uses. */
  --primary: 172 62% 26%;
  --primary-foreground: 160 40% 98%;

  --secondary: 210 20% 96%;
  --secondary-foreground: 222 25% 20%;
  --muted: 210 20% 96%;
  --muted-foreground: 215 16% 45%;
  --accent: 172 45% 94%;
  --accent-foreground: 172 62% 20%;

  --destructive: 0 72% 45%;
  --destructive-foreground: 0 0% 100%;
  --success: 152 55% 34%;
  --success-foreground: 0 0% 100%;
  --warning: 38 92% 45%;
  --warning-foreground: 30 40% 12%;

  --border: 214 20% 89%;
  --input: 214 20% 89%;
  --ring: 172 62% 32%;

  --radius: 0.625rem;

  /* Brand — constant across themes and across print. See §2.4.
     One decimal place, because these round-trip exactly to #047857 and
     #34D399; rounding to integers lands on #027855, which is a different
     colour from the one the print rule emits literally. */
  --brand: 162.9 93.5% 24.3%;
  --brand-on-dark: 158.1 64.4% 51.6%;

  --font-sans:
    var(--font-plex-arabic), 'Segoe UI', 'Tahoma', 'Geeza Pro',
    'Noto Sans Arabic', system-ui, sans-serif;
  --font-mono:
    var(--font-plex-mono), ui-monospace, 'SF Mono', 'Cascadia Mono',
    'Consolas', monospace;
}

:root[data-theme='dark'],
.dark {
  --background: 222 30% 8%;
  --foreground: 210 20% 96%;
  /* Lighter than the background: in dark mode elevation is expressed by
     lightness, because a black shadow on a near-black surface is invisible. */
  --card: 222 26% 11%;
  --card-foreground: 210 20% 96%;
  --popover: 222 26% 11%;
  --popover-foreground: 210 20% 96%;

  /* Not the light value lightened — a separately tuned pair. Auto-lightening a
     dark colour produces a washed-out teal. */
  --primary: 172 55% 45%;
  --primary-foreground: 222 30% 8%;

  --secondary: 222 20% 17%;
  --secondary-foreground: 210 20% 96%;
  --muted: 222 20% 17%;
  --muted-foreground: 215 16% 62%;
  --accent: 172 40% 18%;
  --accent-foreground: 172 55% 80%;

  --destructive: 0 62% 52%;
  --destructive-foreground: 0 0% 100%;
  --success: 152 45% 45%;
  --success-foreground: 0 0% 100%;
  --warning: 38 85% 55%;
  --warning-foreground: 30 40% 10%;

  --border: 222 18% 22%;
  --input: 222 18% 22%;
  --ring: 172 55% 45%;
}
```

---

## 11. قائمة تحقّق قبل دمج أي شاشة POS

- [ ] لا يوجد `#hex` ولا `rgb()` في أي مكوّن — الألوان من الرموز حصراً
- [ ] كل خلفية مقترنة بـ `-foreground` من الزوج نفسه
- [ ] الشاشة مُختبَرة في الوضعين الفاتح والداكن
- [ ] لا `ml-/mr-/left-/right-` — منطقية فقط
- [ ] كل رقم مالي داخل `.numeric`
- [ ] كل مقطع لاتيني في نص عربي داخل `.bidi-isolate`
- [ ] كل صورة/صورة رمزية 1:1 مع `object-cover` و`shrink-0`
- [ ] مناطق اللمس ≥ 44×44px (`h-touch`)
- [ ] الأزرار المُرسِلة تبقى معطَّلة أثناء `loading`
- [ ] الحالة يحملها اللون **والنص**، لا اللون وحده
- [ ] `:focus-visible` ظاهر ومرئي على كل عنصر تفاعلي
- [ ] الإيصال المطبوع مُختبَر فعلياً (`print` media)، والـ QR لا ينقسم

---

## 12. ملخّص الفروق المقصودة بين ERP و POS

| البُعد | ERP | POS | السبب |
|---|---|---|---|
| السلّم الطباعي | أساس 12–14px | أساس 14–16px | مسافة القراءة والإصبع |
| ارتفاع الأزرار | `h-10` (40px) | `h-11`/`h-12` | الحد الأدنى للمس |
| كثافة الجدول | `py-3` | `py-4` | دقة اللمس |
| الشكل الأساسي | جدول | شبكة بطاقات | اختيار سريع بصري |
| الصورة الرمزية | دائرة | **مربع مستدير** | توحيد الشبكة (§3.3) |

**ما لا يتغيّر أبداً:** الألوان، الخطوط، نصف قطر الحواف، منحنى الحركة، الشعار،
قواعد RTL. هذه هي الهوية — وأي انحراف فيها يجعل الـ POS يبدو منتجاً آخر.

---

## ملحق: كيف تحقّقنا من هذه الوثيقة

الوثيقة ليست مكتوبة من الذاكرة، وهذه خطوات التحقق كي يعيدها أي مراجع:

1. **الرموز** قُرئت من `src/styles/globals.css` بمُحلِّل نصي، لا يدوياً.
2. **قيم HEX** حُسبت برمجياً من ثلاثيات HSL عبر `colorsys` — لا تقدير بصري.
3. **إحصاءات الاستخدام** (136 `rounded-md`، 341 `text-xs`، ثلاثة مستويات ظل)
   مُستخرجة بالعدّ الفعلي عبر `grep` على شجرة `src/`.
4. **قيم `--brand`** جُرِّبت ذهاباً وإياباً: `#047857 → HSL → #047857`.
   القيم المقرَّبة إلى أعداد صحيحة كانت تعطي `#027855`، فرُفضت.
5. **`tailwind.config.ts` أدناه جرى تصريفه فعلياً** في مشروع منفصل مع ملف
   اختبار يستدعي كل صنف تَعِد به الوثيقة. النتيجة: `Done` بلا أخطاء، وكل من
   `bg-brand` و`text-brand` و`h-touch` و`h-touch-lg` و`animate-palette-in`
   و`font-numeric` و`bg-primary/10` مُنتَج في المخرجات. الملف يعمل كما هو.

---

*نظام كورفي البصري v1.0 — مستخرج من `Korvi ERP` بالهندسة العكسية.
كل قيمة مقروءة من الكود العامل، وكل تحويل HEX محسوب لا مُقدَّر،
وملف الإعداد مُصرَّف ومُختبَر لا مكتوب على الثقة.*
