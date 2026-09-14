import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { createZatcaApi } from '../zatca-api';

describe('ZATCA merchant web client', () => {
  it(
    'uses the bounded read-only merchant status route with same-origin credentials',
    async () => {
      const fetch = vi.fn(async () =>
        new Response(
          JSON.stringify({
            summary: {
              terminalCount: '1',
              complianceReadyTerminalCount: '1',
              acceptedSubmissionCount: '3',
              rejectedSubmissionCount: '0',
              unresolvedSubmissionCount: '0',
            },
            terminals: [],
            terminalHasMore: false,
            recentSubmissions: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

      const result = await createZatcaApi(fetch).status();

      expect(result.summary.acceptedSubmissionCount).toBe('3');
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledWith(
        '/v1/admin/zatca/status?terminalLimit=100&submissionLimit=25',
        expect.objectContaining({
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        }),
      );
    },
  );

  it('preserves server authorization failures as ApiError instead of inventing state', async () => {
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(createZatcaApi(fetch).status()).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      code: 'forbidden',
    } satisfies Partial<ApiError>);
  });

  it('maps transport failure to the normal network failure contract', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('offline');
    });

    await expect(createZatcaApi(fetch).status()).rejects.toMatchObject({
      name: 'ApiError',
      status: 0,
      code: 'network',
    } satisfies Partial<ApiError>);
  });
});
