import { z } from '../../web/node_modules/zod/index.js';
import type { AdminActionResult } from '../../web/src/server/admin-actions';
import { present } from './fixtures';

export { z };

/** A stored or returned JSON value, checked against the shape the test reads from it. */
export function parseJson<T>(text: string | null | undefined, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(present(text, 'JSON text')));
}

export async function responseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await response.json());
}

/** The data of an admin action that must have succeeded. */
export function actionData<T>(result: AdminActionResult, schema: z.ZodType<T>): T {
  if (!result.ok) throw new Error(`expected the action to succeed, got: ${result.error}`);
  return schema.parse(result.data);
}

/** The failure of an admin action that must have been refused. */
export function actionFailure(
  result: AdminActionResult
): Extract<AdminActionResult, { ok: false }> {
  if (result.ok) throw new Error('expected the action to be refused, but it succeeded');
  return result;
}
