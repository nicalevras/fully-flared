import type { StoreLimits } from '@/lib/settings-definitions';

export const limits: StoreLimits = {
  checkout_email_cap: 5,
  checkout_account_cap: 10,
  checkout_ip_cap: 20,
  cart_max_qty: 99,
  cart_max_lines: 50,
  order_max_units: 500,
  checkout_session_minutes: 30,
  refund_retry_cap: 5,
  refund_stuck_minutes: 30,
};
