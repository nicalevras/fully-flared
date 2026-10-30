import { vi } from 'vitest';

export type StripeHttpRequest = { url: URL; method: string; params: URLSearchParams };

/** Answers the Stripe SDK at its HTTP boundary (the global fetch its client calls) and records
 *  each request's form-encoded params. Undo with vi.unstubAllGlobals(). */
export function stubStripeHttp(
  respond: (request: StripeHttpRequest) => Response | Promise<Response>
): StripeHttpRequest[] {
  const requests: StripeHttpRequest[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: StripeHttpRequest = {
      url: new URL(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      params: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    };
    requests.push(request);
    return respond(request);
  });
  return requests;
}

/** The form keys Stripe encoded under `prefix`, e.g. `line_items[0][price_data]`. */
export function paramKeys(params: URLSearchParams, prefix: string): string[] {
  return [...params.keys()].filter((key) => key === prefix || key.startsWith(`${prefix}[`));
}
