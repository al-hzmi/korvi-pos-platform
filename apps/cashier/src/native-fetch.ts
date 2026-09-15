import { invoke } from '@tauri-apps/api/core';

interface NativeRequest {
  readonly path: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

interface NativeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

function abortError(): DOMException {
  return new DOMException('The native request was aborted by the cashier runtime.', 'AbortError');
}

export async function nativeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (init.signal?.aborted === true) throw abortError();
  if (typeof init.body !== 'string' && init.body !== undefined && init.body !== null) {
    throw new TypeError('Korvi Cashier native transport only accepts canonical string request bodies.');
  }

  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });

  const response = await invoke<NativeResponse>('api_request', {
    request: {
      path: input,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : null,
    } satisfies NativeRequest,
  });

  if (init.signal?.aborted === true) throw abortError();
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
