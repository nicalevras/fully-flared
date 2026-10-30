import type { SearchSchemaInput } from '../../web/node_modules/@tanstack/react-router';

/** The router's raw-search marker: spread it into a literal to call a validateSearch parser
 *  with the input type the router hands it. */
export const rawSearch: SearchSchemaInput = { __TSearchSchemaInput__: 'TSearchSchemaInput' };

/** A route handler result that must be a Response rather than a next() hand-off. */
export function routeResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  throw new Error('the route handler did not answer with a Response');
}

export function noNext(): never {
  throw new Error('next() is not part of this test');
}
