import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnboardingPanel } from '../control/onboarding-panel';
import { ProductsPanel } from '../control/products-panel';
import type { ApiClient } from '../../lib/api';

const idleApi = {} as ApiClient;

describe('guided onboarding first paint', () => {
  it('waits for server evidence instead of claiming ready or incomplete', () => {
    const markup = renderToStaticMarkup(
      createElement(OnboardingPanel, {
        api: idleApi,
        permissions: ['settings.manage', 'users.manage', 'product.write'],
        onNavigate: () => undefined,
      }),
    );

    expect(markup).toContain('جارٍ التحقق من جاهزية المنشأة');
    expect(markup).not.toContain('المنشأة جاهزة للتشغيل');
    expect(markup).not.toContain('إكمال إعداد كورفي');
    expect(markup).not.toContain('فتح الخطوة');
  });

  it('shows the product creation authority only to a session allowed to write products', () => {
    const writer = renderToStaticMarkup(
      createElement(ProductsPanel, { api: idleApi, canWrite: true }),
    );
    const reader = renderToStaticMarkup(
      createElement(ProductsPanel, { api: idleApi, canWrite: false }),
    );

    expect(writer).toContain('إضافة صنف');
    expect(writer).toContain('إنشاء الصنف');
    expect(writer).toContain('السعر (ر.س)');
    expect(reader).toContain('عرض فقط في هذه الجلسة');
    expect(reader).not.toContain('إنشاء الصنف');
  });
});
