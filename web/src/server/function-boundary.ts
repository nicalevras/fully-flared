import { createMiddleware } from '@tanstack/react-start';
import { getRequest, getResponseStatus, setResponseStatus } from '@tanstack/react-start/server';
import { isRedirect, isNotFound } from '@tanstack/react-router';
import { z } from 'zod';
import { AuthError } from './session';
import { CheckoutError } from './checkout';
import { InsufficientStock } from './inventory';
import { StoreLimitError } from '../schemas/limits';

// Start's Standard Schema adapter turns issues into a plain Error. Calling
// parse preserves ZodError so the HTTP boundary can return the correct status.
export function validateServerInput<T extends z.ZodType>(schema: T) {
  return (input: z.input<T>): z.output<T> => schema.parse(input);
}

export const functionBoundary = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (isRedirect(error) || isNotFound(error) || error instanceof Response) throw error;
    if (error instanceof AuthError) {
      setResponseStatus(error.code === 'UNAUTHENTICATED' ? 401 : 403);
      throw error;
    }
    if (error instanceof z.ZodError) {
      setResponseStatus(400);
      throw new Error('Invalid input');
    }
    if (error instanceof CheckoutError) {
      setResponseStatus(error.status);
      throw error;
    }
    if (error instanceof InsufficientStock) {
      setResponseStatus(409);
      throw new Error('Some items are no longer available');
    }
    if (error instanceof StoreLimitError) {
      setResponseStatus(409);
      throw error;
    }
    if (getResponseStatus() >= 400 && getResponseStatus() < 500) throw error;
    setResponseStatus(500);
    console.error(
      JSON.stringify({
        event: 'server_function_failed',
        path: new URL(getRequest().url).pathname,
        error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
      })
    );
    throw new Error('Request failed. Please try again.');
  }
});
