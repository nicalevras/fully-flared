-- Fresh-install defaults. All values are installer-editable in admin Settings.
INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES
  ('store_name', 'My Store', datetime('now')),
  ('currency', 'USD', datetime('now')),
  ('currency_locked', '0', datetime('now')),
  ('canonical_base_url', '', datetime('now')),
  ('email_from_name', 'My Store', datetime('now')),
  ('email_from_address', 'orders@example.com', datetime('now')),
  ('stripe_tax_enabled', '0', datetime('now')),
  ('stripe_tax_confirmed', '0', datetime('now')),
  ('collect_shipping', '1', datetime('now'));

-- Development fixture product (safe to delete).
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at)
VALUES ('prod_tracer', 'tracer-tee', 'Tracer Tee', 'Seeded in D1 and SSR-rendered by TanStack Start.', 'active', datetime('now'), datetime('now'));
INSERT OR IGNORE INTO variants (id, product_id, sku, title, price_cents, created_at)
VALUES ('var_tracer_m', 'prod_tracer', 'TEE-BLK-M', 'Black / M', 2999, datetime('now'));
INSERT OR IGNORE INTO stock (sku, on_hand, reserved, updated_at)
VALUES ('TEE-BLK-M', 100, 0, datetime('now'));
INSERT OR IGNORE INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, created_at)
VALUES ('led_seed_tee', 'TEE-BLK-M', 100, 0, 'restock', datetime('now'));

-- Demo catalogue so a fresh install shows the storefront at full density.
-- Delete or replace these in Admin > Products; they are ordinary products.
INSERT OR IGNORE INTO products (id, slug, title, description, status, created_at, updated_at) VALUES
  ('prod_tote', 'everyday-tote', 'Everyday Tote', 'Heavy cotton canvas tote with an inside pocket. Carries a laptop, a novel, and the shopping.', 'active', datetime('now'), datetime('now')),
  ('prod_mug', 'stoneware-mug', 'Stoneware Mug', 'Hand-finished stoneware, 350ml. Dishwasher, microwave, and Monday-morning safe.', 'active', datetime('now'), datetime('now')),
  ('prod_shirt', 'linen-shirt', 'Linen Shirt', 'Breathable European linen with a relaxed cut that softens with every wash.', 'active', datetime('now'), datetime('now')),
  ('prod_lamp', 'desk-lamp', 'Desk Lamp', 'A small lamp with a heavy base, warm light, and a switch that feels like it means it.', 'active', datetime('now'), datetime('now')),
  ('prod_notebook', 'field-notebook', 'Field Notebook', 'Lay-flat notebook, 160 pages of thick paper that takes fountain pen without bleed.', 'active', datetime('now'), datetime('now'));
INSERT OR IGNORE INTO variants (id, product_id, sku, title, price_cents, created_at) VALUES
  ('var_tote', 'prod_tote', 'TOTE-NAT', 'Natural', 4200, datetime('now')),
  ('var_mug', 'prod_mug', 'MUG-SAGE', 'Sage', 2400, datetime('now')),
  ('var_shirt', 'prod_shirt', 'SHIRT-WHT-M', 'White / M', 7800, datetime('now')),
  ('var_lamp', 'prod_lamp', 'LAMP-BLK', 'Black', 9600, datetime('now')),
  ('var_notebook', 'prod_notebook', 'NOTE-A5', 'A5', 1800, datetime('now'));
INSERT OR IGNORE INTO stock (sku, on_hand, reserved, updated_at) VALUES
  ('TOTE-NAT', 40, 0, datetime('now')),
  ('MUG-SAGE', 85, 0, datetime('now')),
  ('SHIRT-WHT-M', 12, 0, datetime('now')),
  ('LAMP-BLK', 7, 0, datetime('now')),
  ('NOTE-A5', 200, 0, datetime('now'));
INSERT OR IGNORE INTO stock_ledger (id, sku, delta_on_hand, delta_reserved, reason, created_at) VALUES
  ('led_seed_tote', 'TOTE-NAT', 40, 0, 'restock', datetime('now')),
  ('led_seed_mug', 'MUG-SAGE', 85, 0, 'restock', datetime('now')),
  ('led_seed_shirt', 'SHIRT-WHT-M', 12, 0, 'restock', datetime('now')),
  ('led_seed_lamp', 'LAMP-BLK', 7, 0, 'restock', datetime('now')),
  ('led_seed_notebook', 'NOTE-A5', 200, 0, 'restock', datetime('now'));

-- Default content pages (installer-editable in Admin > Pages via D1 content).
INSERT OR IGNORE INTO pages (id, slug, title, content_html, created_at, updated_at) VALUES
  ('page_shipping', 'shipping', 'Shipping', '<p>Orders ship within 2 business days. Rates are calculated at checkout by destination zone.</p>', datetime('now'), datetime('now')),
  ('page_returns', 'returns', 'Returns', '<p>Request a return from your account page within 30 days of delivery. Approved returns are refunded to the original payment method.</p>', datetime('now'), datetime('now')),
  ('page_privacy', 'privacy', 'Privacy', '<p>We use your data only to fulfil orders and operate this store. Order data can be exported or deleted on request.</p>', datetime('now'), datetime('now')),
  ('page_terms', 'terms', 'Terms', '<p>All sales are subject to availability and confirmation of the order price.</p>', datetime('now'), datetime('now'));
