import Stripe from 'stripe';
import type { WorkerEnv } from './env';

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
};

export type ProviderCallOptions = { timeoutMs: number };

export interface PaymentProvider {
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
  retrieveRefund?(refundId: string): Promise<{ id: string; status: string } | null>;
  findRefundByOperation?(
    paymentIntentId: string,
    operationId: string
  ): Promise<{ id: string; status: string } | null>;
  findCheckoutSessionIdByPaymentIntent?(paymentIntentId: string): Promise<string | null>;
  listCheckoutSessionsPage?(input: {
    limit: number;
    startingAfter?: string | undefined;
  }): Promise<{ data: StripeSessionLite[]; hasMore: boolean }>;
  retrieveCheckoutSession?(
    sessionId: string,
    options?: ProviderCallOptions
  ): Promise<StripeSessionLite | null>;
}

export class StripeProvider implements PaymentProvider {
  private stripe: Stripe;
  constructor(
    secretKey: string,
    private webhookSecret: string
  ) {
    // Pinned to the stripe-node v23 generated API version. The Stripe
    // Dashboard webhook endpoint must be configured for the same version:
    // 2026-09-30.endive (see LAUNCH.md).
    // Bounded timeout, no hidden SDK retries: application-level recovery
    // owns replay so an ambiguous outcome is never silently retried with
    // a different operation identity.
    this.stripe = new Stripe(secretKey, {
      apiVersion: '2026-09-30.endive',
      timeout: 30_000,
      maxNetworkRetries: 0,
    });
  }

  async createCoupon(req: CheckoutRequest, options?: ProviderCallOptions): Promise<string> {
    // One amount-off coupon per checkout attempt, created with an
    // idempotency key so a retried session creation reuses it instead of
    // minting a new coupon every time.
    const coupon = await this.stripe.coupons.create(
      {
        amount_off: req.discountCents ?? 0,
        currency: req.currency.toLowerCase(),
        duration: 'once',
        name: req.discountCode ?? 'Discount',
      },
      // Initiation-path provider call: bounded per call (Phase 5); the
      // shared client keeps its 30 s timeout for non-initiation flows.
      { idempotencyKey: `coupon_${req.attemptId}`, timeout: options?.timeoutMs ?? 10_000 }
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
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: req.email,
        currency: req.currency.toLowerCase(),
        line_items: req.lineItems.map((i) => ({
          price_data: {
            currency: req.currency.toLowerCase(),
            product_data: {
              name: i.name,
              ...(req.automaticTax && i.taxCode ? { tax_code: i.taxCode } : {}),
            },
            unit_amount: i.unitAmountCents,
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

  async listCheckoutSessionsPage(input: {
    limit: number;
    startingAfter?: string | undefined;
  }): Promise<{ data: StripeSessionLite[]; hasMore: boolean }> {
    const page = await this.stripe.checkout.sessions.list({
      limit: input.limit,
      ...(input.startingAfter ? { starting_after: input.startingAfter } : {}),
    });
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
      const s = await this.stripe.checkout.sessions.retrieve(
        sessionId,
        {},
        { timeout: options?.timeoutMs ?? 10_000 }
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
    const event = await this.stripe.webhooks.constructEventAsync(
      payload,
      signature,
      this.webhookSecret
    );
    return { id: event.id, type: event.type, data: event.data.object };
  }

  async retrieveRefund(refundId: string) {
    try {
      const refund = await this.stripe.refunds.retrieve(refundId);
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

export function getStripeProvider(env: WorkerEnv): StripeProvider | null {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) return null;
  return new StripeProvider(env.STRIPE_SECRET_KEY, env.STRIPE_WEBHOOK_SECRET);
}
