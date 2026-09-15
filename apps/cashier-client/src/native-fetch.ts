import { invoke } from '@tauri-apps/api/core';

interface NativeHttpRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

interface NativeHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

function aborted(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/**
 * Cashier WebView -> Rust transport boundary.
 *
 * The WebView never receives a session cookie, bearer token or reusable cloud
 * secret. Rust owns the HTTP cookie jar and derives the API/Web origins from
 * the signed build configuration. The WebView may request only relative Korvi
 * API paths; Rust performs the authoritative allow-list validation.
 */
export async function nativeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (init.signal?.aborted === true) throw aborted();

  const headers = new Headers(init.headers);
  const request: NativeHttpRequest = {
    path: input,
    method: init.method ?? 'GET',
    headers: Object.fromEntries(headers.entries()),
    body: typeof init.body === 'string' ? init.body : null,
  };

  const nativeRequest = invoke<NativeHttpResponse>('http_request', { request });
  const response =
    init.signal === undefined
      ? await nativeRequest
      : await Promise.race([
          nativeRequest,
          new Promise<never>((_, reject) => {
            init.signal?.addEventListener('abort', () => reject(aborted()), { once: true });
          }),
        ]);

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
