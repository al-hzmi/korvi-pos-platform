import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ZatcaPanel } from '../control/zatca-panel';
import type { ZatcaApi } from '../../lib/zatca-api';

const idleApi = {} as ZatcaApi;

describe('ZATCA merchant status first paint', () => {
  it('does not invent compliance or submission state before the server answers', () => {
    const markup = renderToStaticMarkup(createElement(ZatcaPanel, { api: idleApi }));

    expect(markup).toContain('جارٍ قراءة حالة الربط والإرسال');
    expect(markup).not.toContain('أجهزة اجتازت الامتثال');
    expect(markup).not.toContain('إرسالات مقبولة');
    expect(markup).not.toContain('حالة التكامل مع هيئة الزكاة والضريبة والجمارك');
  });
});
