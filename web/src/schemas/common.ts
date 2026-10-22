import * as z from 'zod';

// Shared input primitives. Every value that enters the app passes one of
// these (or a schema built from them) exactly once, at the boundary.

export const nonEmptyString = (max = 500) => z.string().trim().min(1).max(max);
export const idString = z.string().trim().min(1).max(100);
export const slugString = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lowercase words joined by dashes');
export const emailString = z.email().max(254);
export const centsInt = z.number().int().min(0).max(100_000_000);
export const optionalText = (max = 500) => z.string().max(max).optional().default('');
export const nullableText = (max = 500) => z.string().max(max).nullable().optional();

/** Consistent typed validation error for HTTP boundaries. */
export function validationError(error: z.ZodError) {
  return {
    ok: false as const,
    error: 'Invalid input',
    fieldErrors: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  };
}

export function zodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

/** Parse a JSON request body once, at the boundary. Malformed JSON and
 *  schema failures are both typed 400s with field errors — never a silent
 *  empty-object default. */
export async function parseJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: 'Invalid input',
          fieldErrors: [{ path: 'body', message: 'Request body must be valid JSON' }],
        },
        { status: 400 }
      ),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: Response.json(validationError(parsed.error), { status: 400 }) };
  }
  return { ok: true, data: parsed.data };
}
