// Vitest alias target for the Workers-only `cloudflare:workers` module.
// Server modules import the static env binding at module load; under Node
// tests there is no Workers runtime, so the binding is an empty env and
// tests pass explicit fakes (D1, payment providers) instead.
export const env: Record<string, unknown> = {};

// Enough of the Durable Object base for modules that extend it at import
// time; DO behavior itself is exercised through its pure helpers in tests.
export class DurableObject {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

// Same import-time stand-in for named entrypoints (PublicStorefront);
// their behavior is covered through the pure policy helpers in tests.
export class WorkerEntrypoint {
  protected ctx: unknown;
  protected env: unknown;
  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WebSocketRequestResponsePair {
  constructor(
    readonly request: string,
    readonly response: string
  ) {}
}
