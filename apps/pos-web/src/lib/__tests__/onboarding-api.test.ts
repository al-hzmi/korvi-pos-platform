import { describe, expect, it } from 'vitest';
import { createApiClient } from '../api';

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function transport(body: unknown = {}): {
  readonly calls: Recorded[];
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: (url, init) => {
      calls.push({ url, init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    },
  };
}

function bodyOf(call: Recorded): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

describe('guided onboarding API client', () => {
  it('reads readiness without a tenant, actor or completion parameter', async () => {
    const wire = transport({ ready: false, checks: [] });
    await createApiClient(wire.fetch).onboardingReadiness();

    const call = wire.calls[0]!;
    expect(call.url).toBe('/v1/admin/onboarding/readiness');
    expect(call.init.method).toBe('GET');
    expect(call.init.body).toBeUndefined();
    expect(call.url).not.toMatch(/tenant|actor|complete/);
  });

  it('creates a product from catalogue facts only and keeps money exact', async () => {
    const wire = transport({ id: 'p-1' });
    await createApiClient(wire.fetch).createAdminProduct({
      sku: 'COFFEE-01',
      nameAr: 'قهوة',
      nameEn: 'Coffee',
      productType: 'unit',
      unitLabel: 'each',
      priceMinor: '1250',
      barcode: '6281000000012',
    });

    const call = wire.calls[0]!;
    const body = bodyOf(call);
    expect(call.url).toBe('/v1/admin/products');
    expect(call.init.method).toBe('POST');
    expect(body).toEqual({
      sku: 'COFFEE-01',
      nameAr: 'قهوة',
      nameEn: 'Coffee',
      productType: 'unit',
      unitLabel: 'each',
      priceMinor: '1250',
      barcode: '6281000000012',
    });
    expect(typeof body['priceMinor']).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(
      /tenantId|actorUserId|userId|trackInventory|isActive|quantityScaled|priceHistory|permissions|roles/,
    );
  });

  it('omits absent optional product fields rather than inventing null authority', async () => {
    const wire = transport({ id: 'p-2' });
    await createApiClient(wire.fetch).createAdminProduct({
      sku: 'TEA-01',
      nameAr: 'شاي',
      productType: 'unit',
      unitLabel: 'each',
      priceMinor: '500',
    });

    expect(bodyOf(wire.calls[0]!)).toEqual({
      sku: 'TEA-01',
      nameAr: 'شاي',
      productType: 'unit',
      unitLabel: 'each',
      priceMinor: '500',
    });
  });
});
