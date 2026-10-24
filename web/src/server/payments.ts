import Stripe from 'stripe';
import type { WorkerEnv } from './env';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ShippingAddress } from '../schemas/checkout';

// PaymentProvider seam (DECISIONS D4). Stripe is the only v1 implementation.
export interface CheckoutRequest {
  orderId: string;
  attemptId: string;
  email: string;
  currency: string;
  lineItems: { name: string; unitAmountCents: number; qty: number; taxCode?: string | null }[];
  /** Server-computed discount (cents). Sent to Stripe as a single
   *  amount-off coupon so the charged total always equals the order total;
   *  a percent coupon would also discount the shipping amount. */
  discountCents?: number | undefined;
  discountCode?: string | undefined;
  /** Charged via Checkout shipping_options, never as a line item, so
   *  discounts can never apply to it. */
  shippingCents?: number | undefined;
  successUrl: string;
  cancelUrl: string;
  collectShipping: boolean;
  shippingCountries: string[];
  automaticTax: boolean;
  expiresAtEpochSeconds: number;
  shippingAddress?: ShippingAddress;
  customerId?: string;
}

export interface CheckoutResult {
  sessionId: string;
  url: string;
}

export type StripeSessionLite = {
  id: string;
  payment_status: string;
  amount_total: number | null;
  currency: string;
  payment_intent: string | null;
  url?: string | null;
  status?: string | null;
  metadata?: { order_id?: string; attempt_id?: string };
  collected_information?: unknown;
  mode?: string;
  taxCents?: number;
  subtotalCents?: number;
  discountCents?: number;
  shippingCents?: number;
  automaticTaxStatus?: string | null;
};

export type PaymentIntentDetails = {
  id: string;
  status: string;
  amount: number;
  amountCapturable: number;
  amountReceived: number;
  currency: string;
  metadata: { order_id?: string; attempt_id?: string };
  captureBefore?: number;
};

export type ProviderCallOptions = { timeoutMs: number };

export interface PaymentProvider {
  withinDeadline?<T>(options: ProviderCallOptions, action: () => Promise<T>): Promise<T>;
  createCheckoutCustomer?(req: CheckoutRequest, options: ProviderCallOptions): Promise<string>;
  retrievePaymentIntent?(id: string, options: ProviderCallOptions): Promise<PaymentIntentDetails>;
  capturePaymentIntent?(
    id: string,
    amount: number,
    key: string,
    options: ProviderCallOptions
  ): Promise<PaymentIntentDetails>;
  cancelPaymentIntent?(
    id: string,
    key: string,
    options: ProviderCallOptions
  ): Promise<PaymentIntentDetails>;
  expireCheckoutSession?(id: string, key: string, options: ProviderCallOptions): Promise<void>;
  createCheckout(req: CheckoutRequest, options?: ProviderCallOptions): Promise<CheckoutResult>;
  /** Split initiation steps (Phase 1): the intent flow stores the coupon
   *  result before creating the session so recovery resumes the right
   *  step. Both steps are idempotency-keyed exactly like createCheckout. */
  createCoupon?(req: CheckoutRequest, options?: ProviderCallOptions): Promise<string>;
  createCheckoutSession?(
    req: CheckoutRequest,
    couponId?: string,
    options?: ProviderCallOptions
  ): Promise<CheckoutResult>;
  verifyWebhook(
    payload: string,
    signature: string
  ): Promise<{ id: string; type: string; data: unknown }>;
  refund(
    paymentIntentId: string,
    amountCents: number | undefined,
    refundRowId: string
  ): Promise<{ id: string; status: string }>;
  listRefunds?(paymentIntentId: string): Promise<
    Array<{
      id: string;
      status: string;
      amount: number;
      payment_intent: string;
      metadata: { operation_id?: string };
    }>
  >;
  retrieveRefund?(
    refundId: string,
    options?: ProviderCallOptions
  ): Promise<{ id: string; status: string } | null>;
  findRefundByOperation?(
    paymentIntentId: string,
    operationId: string
  ): Promise<{ id: string; status: string } | null>;
  findCheckoutSessionIdByPaymentIntent?(paymentIntentId: string): Promise<string | null>;
  listCheckoutSessionsPage?(
    input: {
      limit: number;
      startingAfter?: string | undefined;
      createdBefore?: number;
    },
    options?: ProviderCallOptions
  ): Promise<{ data: StripeSessionLite[]; hasMore: boolean }>;
  retrieveCheckoutSession?(
    sessionId: string,
    options?: ProviderCallOptions
  ): Promise<StripeSessionLite | null>;
}

export class StripeProvider implements PaymentProvider {
  private stripe: Stripe;
  private deadlines = new AsyncLocalStorage<number>();
  private bounded<T>(
    options: ProviderCallOptions | undefined,
    action: () => Promise<T>
  ): Promise<T> {
    const duration = Math.min(
      options?.timeoutMs ?? 10_000,
      (this.deadlines.getStore() ?? Infinity) - Date.now()
    );
    if (duration <= 0) return Promise.reject(new Error('Provider deadline exceeded'));
    return this.deadlines.run(
      Date.now() + duration,
      () =>
        new Promise<T>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Provider deadline exceeded')), duration);
          Promise.resolve()
            .then(action)
            .then(resolve, reject)
            .finally(() => clearTimeout(timer));
        })
    );
  }
  withinDeadline<T>(options: ProviderCallOptions, action: () => Promise<T>): Promise<T> {
    return this.bounded(options, action);
  }
  constructor(
    secretKey: string,
    private webhookSecret: string
  ) {
    // Pinned to the stripe-node v23 generated API version. The Stripe
    // Dashboard webhook endpoint must be configured for the same version:
    // 2026-09-30.endive (see docs/archive/LAUNCH.md).
    // Even maxNetworkRetries=0 can retry closed connections. The transport
    // shares one absolute deadline across all SDK attempts and response reads.
    this.stripe = new Stripe(secretKey, {
      apiVersion: '2026-09-30.endive',
      timeout: 30_000,
      maxNetworkRetries: 0,
      httpClient: Stripe.createFetchHttpClient((input, init) => {
        const deadline = this.deadlines.getStore();
        const remaining = deadline === undefined ? 30_000 : deadline - Date.now();
        if (remaining <= 0) throw new Error('Provider deadline exceeded');
        const signal = AbortSignal.timeout(remaining);
        return fetch(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        });
      }),
    });
  }

  async createCheckoutCustomer(
    req: CheckoutRequest,
    options: ProviderCallOptions
  ): Promise<string> {
    if (!req.shippingAddress) throw new Error('Shipping address is required');
    const a = req.shippingAddress;
    const customer = await this.bounded(options, () =>
      this.stripe.customers.create(
        {
          email: req.email,
          name: a.name,
          shipping: {
            name: a.name,
            ...(a.phone ? { phone: a.phone } : {}),
            address: {
              line1: a.line1,
              line2: a.line2,
              city: a.city,
              state: a.state,
              postal_code: a.postalCode,
              country: a.country,
            },
          },
          metadata: { order_id: req.orderId, attempt_id: req.attemptId },
        },
        { idempotencyKey: `customer_${req.attemptId}`, timeout: options.timeoutMs }
      )
    );
    return customer.id;
  }

  private paymentDetails(pi: Stripe.PaymentIntent): PaymentIntentDetails {
    const charge = typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    return {
      id: pi.id,
      status: pi.status,
      amount: pi.amount,
      amountCapturable: pi.amount_capturable,
      amountReceived: pi.amount_received,
      currency: pi.currency,
      metadata: pi.metadata,
      ...(charge?.payment_method_details?.card?.capture_before
        ? { captureBefore: charge.payment_method_details.card.capture_before }
        : {}),
    };
  }
  async retrievePaymentIntent(id: string, options: ProviderCallOptions) {
    return this.paymentDetails(
      await this.bounded(options, () =>
        this.stripe.paymentIntents.retrieve(
          id,
          { expand: ['latest_charge'] },
          { timeout: options.timeoutMs }
        )
      )
    );
  }
  async capturePaymentIntent(
    id: string,
    amount: number,
    key: string,
    options: ProviderCallOptions
  ) {
    return this.paymentDetails(
      await this.bounded(options, () =>
        this.stripe.paymentIntents.capture(
          id,
          { amount_to_capture: amount },
          { idempotencyKey: key, timeout: options.timeoutMs }
        )
      )
    );
  }
  async cancelPaymentIntent(id: string, key: string, options: ProviderCallOptions) {
    return this.paymentDetails(
      await this.bounded(options, () =>
        this.stripe.paymentIntents.cancel(
          id,
          {},
          { idempotencyKey: key, timeout: options.timeoutMs }
        )
      )
    );
  }
  async expireCheckoutSession(id: string, key: string, options: ProviderCallOptions) {
    await this.bounded(options, () =>
      this.stripe.checkout.sessions.expire(
        id,
        {},
        { idempotencyKey: key, timeout: options.timeoutMs }
      )
    );
  }

  async createCoupon(req: CheckoutRequest, options?: ProviderCallOptions): Promise<string> {
    // One amount-off coupon per checkout attempt, created with an
    // idempotency key so a retried session creation reuses it instead of
    // minting a new coupon every time.
    const coupon = await this.bounded(options, () =>
      this.stripe.coupons.create(
        {
          amount_off: req.discountCents ?? 0,
          currency: req.currency.toLowerCase(),
          duration: 'once',
          name: req.discountCode ?? 'Discount',
        },
        // Initiation-path provider call: bounded per call (Phase 5); the
        // shared client keeps its 30 s timeout for non-initiation flows.
        { idempotencyKey: `coupon_${req.attemptId}`, timeout: options?.timeoutMs ?? 10_000 }
      )
    );
    return coupon.id;
  }

  async createCheckout(
    req: CheckoutRequest,
    options?: ProviderCallOptions
  ): Promise<CheckoutResult> {
    const couponId =
      req.discountCents && req.discountCents > 0
        ? await this.createCoupon(req, options)
        : undefined;
    return this.createCheckoutSession(req, couponId, options);
  }

  async createCheckoutSession(
    req: CheckoutRequest,
    couponId?: string,
    options?: ProviderCallOptions
  ): Promise<CheckoutResult> {
    const session = await this.bounded(options, () =>
      this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          ...(req.customerId ? { customer: req.customerId } : { customer_email: req.email }),
          allowed_payment_method_types: ['card'],
          adaptive_pricing: { enabled: false },
          payment_intent_data: {
            capture_method: 'manual',
            metadata: { order_id: req.orderId, attempt_id: req.attemptId },
            ...(req.shippingAddress
              ? {
                  shipping: {
                    name: req.shippingAddress.name,
                    ...(req.shippingAddress.phone ? { phone: req.shippingAddress.phone } : {}),
                    address: {
                      line1: req.shippingAddress.line1,
                      line2: req.shippingAddress.line2,
                      city: req.shippingAddress.city,
                      state: req.shippingAddress.state,
                      postal_code: req.shippingAddress.postalCode,
                      country: req.shippingAddress.country,
                    },
                  },
                }
              : {}),
          },
          currency: req.currency.toLowerCase(),
          line_items: req.lineItems.map((i) => ({
            price_data: {
              currency: req.currency.toLowerCase(),
              product_data: {
                name: i.name,
                ...(req.automaticTax && i.taxCode ? { tax_code: i.taxCode } : {}),
              },
              unit_amount: i.unitAmountCents,
              tax_behavior: 'exclusive',
            },
            quantity: i.qty,
          })),
          automatic_tax: { enabled: req.automaticTax },
          ...(req.collectShipping
            ? {
                shipping_address_collection: {
                  allowed_countries:
                    req.shippingCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
                },
              }
            : {}),
          ...(req.shippingCents != null
            ? {
                shipping_options: [
                  {
                    shipping_rate_data: {
                      type: 'fixed_amount' as const,
                      tax_behavior: 'exclusive',
                      display_name: 'Shipping',
                      fixed_amount: {
                        amount: req.shippingCents,
                        currency: req.currency.toLowerCase(),
                      },
                    },
                  },
                ],
              }
            : {}),
          success_url: req.successUrl,
          cancel_url: req.cancelUrl,
          expires_at: req.expiresAtEpochSeconds,
          ...(couponId ? { discounts: [{ coupon: couponId }] } : {}),
          metadata: { order_id: req.orderId, attempt_id: req.attemptId },
        },
        { idempotencyKey: `checkout_${req.attemptId}`, timeout: options?.timeoutMs ?? 10_000 }
      )
    );
    if (!session.url) throw new Error('Stripe did not return a checkout URL');
    return { sessionId: session.id, url: session.url };
  }

  async findCheckoutSessionIdByPaymentIntent(paymentIntentId: string): Promise<string | null> {
    const sessions = await this.stripe.checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });
    return sessions.data[0]?.id ?? null;
  }

  async listCheckoutSessionsPage(
    input: {
      limit: number;
      startingAfter?: string | undefined;
      createdBefore?: number;
    },
    options?: ProviderCallOptions
  ): Promise<{ data: StripeSessionLite[]; hasMore: boolean }> {
    const page = await this.bounded(options, () =>
      this.stripe.checkout.sessions.list(
        {
          limit: input.limit,
          ...(input.startingAfter ? { starting_after: input.startingAfter } : {}),
          ...(input.createdBefore ? { created: { lte: input.createdBefore } } : {}),
        },
        { timeout: options?.timeoutMs ?? 10_000 }
      )
    );
    return {
      hasMore: page.has_more,
      data: page.data.map((s) => ({
        url: s.url ?? null,
        status: s.status ?? null,
        id: s.id,
        payment_status: s.payment_status,
        amount_total: s.amount_total,
        currency: s.currency ?? '',
        metadata: s.metadata ?? {},
        collected_information: s.collected_information,
        mode: s.mode,
        payment_intent:
          typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null),
      })),
    };
  }

  async retrieveCheckoutSession(
    sessionId: string,
    options?: ProviderCallOptions
  ): Promise<StripeSessionLite | null> {
    try {
      const s = await this.bounded(options, () =>
        this.stripe.checkout.sessions.retrieve(
          sessionId,
          {},
          { timeout: options?.timeoutMs ?? 10_000 }
        )
      );
      return {
        id: s.id,
        payment_status: s.payment_status,
        amount_total: s.amount_total,
        currency: s.currency ?? '',
        metadata: s.metadata ?? {},
        collected_information: s.collected_information,
        mode: s.mode,
        payment_intent:
          typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent?.id ?? null),
        url: s.url ?? null,
        status: s.status ?? null,
        taxCents: s.total_details?.amount_tax ?? 0,
        discountCents: s.total_details?.amount_discount ?? 0,
        shippingCents: s.total_details?.amount_shipping ?? 0,
        subtotalCents: s.amount_subtotal ?? 0,
        automaticTaxStatus: s.automatic_tax?.status ?? null,
      };
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.statusCode === 404 &&
        error.code === 'resource_missing'
      )
        return null;
      throw error;
    }
  }

  async verifyWebhook(payload: string, signature: string) {
    const event = await this.stripe.webhooks
      .constructEventAsync(payload, signature, this.webhookSecret)
      .catch((error: unknown) => {
        if (error instanceof Stripe.errors.StripeSignatureVerificationError)
          throw new WebhookSignatureError();
        throw error;
      });
    return { id: event.id, type: event.type, data: event.data.object };
  }

  async retrieveRefund(refundId: string, options?: ProviderCallOptions) {
    try {
      const refund = await this.bounded(options, () =>
        this.stripe.refunds.retrieve(refundId, {}, { timeout: options?.timeoutMs ?? 10_000 })
      );
      return { id: refund.id, status: refund.status ?? 'pending' };
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeInvalidRequestError &&
        error.statusCode === 404 &&
        error.code === 'resource_missing'
      )
        return null;
      throw error;
    }
  }

  async listRefunds(paymentIntentId: string) {
    const result: Array<{
      id: string;
      status: string;
      amount: number;
      payment_intent: string;
      metadata: { operation_id?: string };
    }> = [];
    for await (const refund of this.stripe.refunds.list({
      payment_intent: paymentIntentId,
      limit: 100,
    })) {
      if (result.length >= 500) throw new Error('Refund history requires manual reconciliation');
      result.push({
        id: refund.id,
        status: refund.status ?? 'pending',
        amount: refund.amount,
        payment_intent: paymentIntentId,
        metadata: refund.metadata ?? {},
      });
    }
    return result;
  }
  async findRefundByOperation(paymentIntentId: string, operationId: string) {
    const refund = (await this.listRefunds(paymentIntentId)).find(
      (r) => r.metadata.operation_id === operationId
    );
    return refund ? { id: refund.id, status: refund.status } : null;
  }

  async refund(paymentIntentId: string, amountCents: number | undefined, refundRowId: string) {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        metadata: { operation_id: refundRowId },
        ...(amountCents ? { amount: amountCents } : {}),
      },
      // Keyed on the local refund row: two different partial refunds for the
      // same amount are distinct operations, and a retry of one row returns
      // its original Stripe refund instead of double-refunding.
      { idempotencyKey: `refund_${refundRowId}` }
    );
    return { id: refund.id, status: refund.status ?? 'pending' };
  }
}

/** Keep every nested SDK request/retry inside the delivery's shared deadline. */
export function providerWithBudget(
  provider: PaymentProvider,
  deadline: number,
  beforeCall: () => Promise<void>
): PaymentProvider {
  return new Proxy(provider, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        await beforeCall();
        const remaining = deadline - Date.now();
        if (remaining < 5000) throw new Error('Maintenance provider budget exhausted');
        const options = { timeoutMs: Math.min(10_000, remaining) };
        const action = () => Promise.resolve(Reflect.apply(value, target, args));
        if (target.withinDeadline) return target.withinDeadline(options, action);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            action(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Provider deadline exceeded')),
                options.timeoutMs
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
    },
  });
}

export class WebhookSignatureError extends Error {
  constructor() {
    super('Webhook signature verification failed');
    this.name = 'WebhookSignatureError';
  }
}

export function getStripeProvider(env: WorkerEnv): StripeProvider | null {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return null;
  return new StripeProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
}
