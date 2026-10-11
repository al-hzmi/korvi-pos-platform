import { invoke } from '@tauri-apps/api/core';

interface NativeHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

function responseFromNative(result: NativeHttpResponse): Response {
  return new Response(result.body, { status: result.status, headers: result.headers });
}

/**
 * Installed Cashier transport. Browser credentials never exist here.
 * Login/session/logout are translated to Rust-owned Native Auth, and
 * business calls receive KorviNative only inside the Rust process.
 */
export async function nativeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!input.startsWith('/v1/') || input.startsWith('//') || input.includes('://')) {
    throw new Error('Korvi Cashier refused a non-relative API request.');
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (input === '/v1/auth/me' && method === 'GET') {
    return responseFromNative(await invoke<NativeHttpResponse>('native_me'));
  }
  if (input === '/v1/auth/logout' && method === 'POST') {
    return responseFromNative(await invoke<NativeHttpResponse>('native_logout'));
  }
  if (input === '/v1/auth/login' && method === 'POST') {
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    return responseFromNative(
      await invoke<NativeHttpResponse>('native_login', { credentials: body }),
    );
  }

  const headers = new Headers(init.headers);
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() !== 'accept' && name.toLowerCase() !== 'content-type') {
      throw new Error('Korvi Cashier refused a WebView-controlled authority header.');
    }
    safeHeaders[name] = value;
  }
  if (init.signal?.aborted === true) throw new DOMException('Aborted', 'AbortError');
  const request = invoke<NativeHttpResponse>('http_request', {
    request: {
      path: input,
      method,
      headers: safeHeaders,
      body: typeof init.body === 'string' ? init.body : null,
    },
  });
  if (init.signal === undefined) return responseFromNative(await request);
  return await Promise.race([
    request.then(responseFromNative),
    new Promise<Response>((_, reject) =>
      init.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      ),
    ),
  ]);
}
