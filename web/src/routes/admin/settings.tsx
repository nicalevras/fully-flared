import { useState } from 'react';
import { staffMiddleware } from '../../server/staff-middleware';
import { requireStaffPermission } from '../../server/session';
import { createFileRoute, Link } from '@tanstack/react-router';
import { buildSetupChecklist } from '../../lib/setup-checklist';
import {
  AdminActionFeedback,
  type AdminActionFeedbackState,
} from '../../components/AdminActionFeedback';
import { createServerFn } from '@tanstack/react-start';
import {
  LIMIT_KEYS,
  LIMIT_DEFINITIONS,
  ADMISSION_KEYS,
  ADMISSION_DEFINITIONS,
  SUPPORTED_CURRENCIES,
} from '../../lib/settings-definitions';
import { saveSettings } from '../../lib/settings-save';
import { getSettings } from '../../server/settings';
import { resolveMediaSources } from '../../server/media-source';
import { uploadMedia } from '../../lib/upload';
import { mediaUrl } from '../../lib/media-url';
import { useAdminAction } from '../../components/AdminNav';
import {
  btnPrimary,
  cardCls,
  hintCls,
  inputCls,
  labelCls,
  pageSub,
  pageTitle,
} from '../../components/ui';

const getData = createServerFn({ method: 'GET' })
  .middleware([staffMiddleware])
  .handler(async ({ context }) => {
    requireStaffPermission(context.staff, 'settings', 'view');
    const { env } = await import('cloudflare:workers');
    const settings = await getSettings(env.DB);
    const counts = await env.DB.prepare(
      'SELECT (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM shipping_zones) AS zones, (SELECT COUNT(*) FROM shipping_rates) AS rates'
    ).first<{ products: number; zones: number; rates: number }>();
    const checklist = buildSetupChecklist({
      productCount: counts?.products ?? 0,
      shippingZoneCount: counts?.zones ?? 0,
      shippingRateCount: counts?.rates ?? 0,
      storeName: settings.storeName,
      currency: settings.currency,
    });
    const brand = await resolveMediaSources(env.DB, [settings.logoMediaId, settings.heroMediaId]);
    return {
      settings,
      checklist,
      logoSource: brand.get(settings.logoMediaId) ?? null,
      heroSource: brand.get(settings.heroMediaId) ?? null,
    };
  });

export const Route = createFileRoute('/admin/settings')({
  loader: async () => getData(),
  component: AdminSettings,
});

function AdminSettings() {
  const adminAction = useAdminAction();

  const data = Route.useLoaderData();
  const initial = data.settings;
  const checklist = data.checklist;
  const [limits, setLimits] = useState(initial.limits);
  const [admission, setAdmission] = useState(initial.admission);
  const [form, setForm] = useState({
    store_name: initial.storeName,
    logo_media_id: initial.logoMediaId,
    hero_media_id: initial.heroMediaId,
    currency: initial.currency,
    canonical_base_url: initial.canonicalBaseUrl,
    announcement_text: initial.announcementText,
    seo_title_template: initial.seoTitleTemplate,
    email_from_name: initial.emailFromName,
    email_from_address: initial.emailFromAddress,
    operational_alert_email: initial.operationalAlertEmail,
    turnstile_site_key: initial.turnstileSiteKey,
    abandoned_reminders_enabled: initial.abandonedRemindersEnabled ? '1' : '0',
    media_public_base_url: initial.mediaPublicBaseUrl,
  });
  const [tax, setTax] = useState({
    enabled: initial.stripeTaxEnabled,
    confirmed: initial.stripeTaxConfirmed,
  });
  const [feedback, setFeedback] = useState<AdminActionFeedbackState>(null);
  const [saving, setSaving] = useState(false);
  const [logo, setLogo] = useState<{ id: string; src: string } | null>(
    data.logoSource ? { id: initial.logoMediaId, src: mediaUrl(data.logoSource, 320) } : null
  );
  const [hero, setHero] = useState<{ id: string; src: string } | null>(
    data.heroSource ? { id: initial.heroMediaId, src: mediaUrl(data.heroSource, 640) } : null
  );
  const [uploading, setUploading] = useState<'logo' | 'hero' | null>(null);

  async function uploadBrandImage(kind: 'logo' | 'hero', file: File | undefined) {
    if (!file) return;
    setUploading(kind);
    try {
      const uploaded = await uploadMedia(file);
      const picked = { id: uploaded.id, src: uploaded.url ?? `/media/${uploaded.key}` };
      if (kind === 'logo') {
        setLogo(picked);
        setForm((f) => ({ ...f, logo_media_id: uploaded.id }));
      } else {
        setHero(picked);
        setForm((f) => ({ ...f, hero_media_id: uploaded.id }));
      }
    } catch (error) {
      setFeedback({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Image upload failed.',
      });
    } finally {
      setUploading(null);
    }
  }

  function brandImageControl(
    kind: 'logo' | 'hero',
    label: string,
    hint: string,
    current: { id: string; src: string } | null,
    previewCls: string
  ) {
    return (
      <div>
        <label className={labelCls} htmlFor={`s-${kind}-image`}>
          {label}
        </label>
        {current ? (
          <div className="flex items-start gap-3">
            <img src={current.src} alt="" className={previewCls} />
            <button
              type="button"
              className="text-sm text-zinc-600 underline underline-offset-4 hover:text-zinc-950"
              onClick={() => {
                if (kind === 'logo') {
                  setLogo(null);
                  setForm((f) => ({ ...f, logo_media_id: '' }));
                } else {
                  setHero(null);
                  setForm((f) => ({ ...f, hero_media_id: '' }));
                }
              }}
            >
              Remove
            </button>
          </div>
        ) : null}
        <input
          id={`s-${kind}-image`}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className={inputCls}
          disabled={uploading !== null}
          onChange={(e) => {
            void uploadBrandImage(kind, e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <p className={hintCls}>{uploading === kind ? 'Uploading…' : hint}</p>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    const result = await saveSettings(adminAction, { limits, admission, form, tax });
    setSaving(false);
    setFeedback(
      result.ok
        ? {
            kind: 'status',
            message:
              'Settings saved. Storefront name, announcement, currency, and email sender update everywhere immediately.',
          }
        : { kind: 'error', message: result.error }
    );
  }

  const field = (key: keyof typeof form, label: string, hint: string, placeholder?: string) => (
    <div>
      <label className={labelCls} htmlFor={`s-${key}`}>
        {label}
      </label>
      <input
        id={`s-${key}`}
        className={inputCls}
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
      <p className={hintCls}>{hint}</p>
    </div>
  );

  return (
    <main>
      <h1 className={pageTitle}>Settings</h1>
      <p className={pageSub}>
        These settings are stored in your store database. Nothing about your store is hardcoded.
      </p>
      <AdminActionFeedback value={feedback} />

      <section className={`${cardCls} mt-6 space-y-3 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">Set up your store</h2>
        <ul className="space-y-2">
          {checklist.map((item) => (
            <li key={item.key} className="flex items-center gap-2 text-sm">
              <span aria-hidden="true">{item.done ? '✓' : '○'}</span>
              <Link to={item.href} className="text-zinc-900 underline">
                {item.label}
              </Link>
              <span className="text-zinc-500">{item.done ? 'Done' : 'Not yet'}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${cardCls} mt-6 space-y-4 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">Store details</h2>
        {field('store_name', 'Store name', 'Shown in the header, footer, emails, and page titles.')}
        {brandImageControl(
          'logo',
          'Logo',
          'Replaces the store name in the header and footer, and appears in the admin sidebar. The store name stays as its accessible label.',
          logo,
          'h-10 w-auto max-w-48 object-contain'
        )}
        {brandImageControl(
          'hero',
          'Hero image',
          'Shown in the right column of the homepage hero, cropped to a 4:5 portrait. Leave unset for a text-only hero.',
          hero,
          'aspect-[4/5] w-24 rounded-lg object-cover'
        )}
        {field(
          'announcement_text',
          'Announcement bar',
          'Shown at the very top of every storefront page. Leave blank to hide it.',
          'Free shipping on orders over $75'
        )}
        <div>
          <label className={labelCls} htmlFor="s-currency">
            Base currency{initial.currencyLocked ? ' (locked)' : ''}
          </label>
          <select
            id="s-currency"
            className={inputCls}
            value={form.currency}
            disabled={initial.currencyLocked}
            onChange={(e) => setForm({ ...form, currency: e.target.value })}
          >
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <p className={hintCls}>
            {initial.currencyLocked
              ? 'Currency locks after the first live order so historical orders never change meaning.'
              : 'You can change this until your first live order.'}
          </p>
        </div>
        {field(
          'canonical_base_url',
          'Canonical base URL',
          'Used for sitemap, canonical links, and checkout redirects.',
          'https://yourstore.com'
        )}
        {field(
          'seo_title_template',
          'SEO title template',
          'Used when a product or article has no SEO title of its own. Placeholders: {product} and {store_name}.',
          '{product} · {store_name}'
        )}
      </section>

      <section className={`${cardCls} mt-5 space-y-4 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">Email</h2>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.abandoned_reminders_enabled === '1'}
            onChange={(e) =>
              setForm({ ...form, abandoned_reminders_enabled: e.target.checked ? '1' : '0' })
            }
          />
          Enable unfinished-checkout reminders (explicit shopper consent required; default off)
        </label>
        {field(
          'email_from_name',
          'Sender name',
          'Appears as the sender of order confirmations and sign-in links.'
        )}
        {field('operational_alert_email', 'Operational alert email', 'Empty uses verified owners.')}
        {field(
          'email_from_address',
          'Sender address',
          'Must be verified in Cloudflare Email Service.'
        )}
      </section>

      <section className={`${cardCls} mt-5 space-y-3 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">Checkout</h2>
        <p className="text-sm text-zinc-500">
          Physical orders require a shipping address and a configured shipping rate.
        </p>
        {field(
          'turnstile_site_key',
          'Turnstile site key',
          'Public Cloudflare Turnstile widget key for checkout and sign-in. Pair it with the TURNSTILE_SECRET_KEY Worker secret; leave blank to disable the challenge.'
        )}
      </section>

      <section className={`${cardCls} mt-5 space-y-3 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">Taxes</h2>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-zinc-900">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-zinc-950"
            checked={tax.enabled}
            onChange={(e) => setTax({ ...tax, enabled: e.target.checked })}
          />
          <span>
            Collect tax automatically with Stripe Tax
            <span className="block text-[13px] text-zinc-500">
              Stripe calculates and adds tax at checkout based on the customer's shipping address
              and your Stripe account's default product tax code.
            </span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-zinc-900">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-zinc-950"
            checked={tax.confirmed}
            onChange={(e) => setTax({ ...tax, confirmed: e.target.checked })}
          />
          <span>
            My Stripe Tax setup is complete
            <span className="block text-[13px] text-zinc-500">
              Confirm registrations are active and a default product tax code is set in the Stripe
              dashboard. Live checkout refuses automatic tax until both boxes are on.
            </span>
          </span>
        </label>
      </section>

      <section className={`${cardCls} mt-6 space-y-4 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">Advanced: store limits</h2>
        <p className={hintCls}>
          Technical guardrails for catalog size and stock holds. Most stores never need to change
          these.
        </p>
        {LIMIT_KEYS.map((key) => {
          const spec = LIMIT_DEFINITIONS[key];
          return (
            <div key={key}>
              <label className={labelCls} htmlFor={`s-${key}`}>
                {spec.label}
              </label>
              <input
                id={`s-${key}`}
                className={inputCls}
                type="number"
                min={spec.min}
                max={spec.max}
                step={1}
                required
                value={limits[key]}
                onChange={(event) => setLimits({ ...limits, [key]: event.target.valueAsNumber })}
              />
              <p className={hintCls}>
                Range {spec.min}–{spec.max}; default {spec.default}. Existing holds keep their
                expiry.
              </p>
            </div>
          );
        })}
        {field(
          'media_public_base_url',
          'Public media origin (optional, advanced)',
          'Enable only after configuring PUBLIC_MEDIA, MEDIA_ZONE_ID and MEDIA_PURGE_TOKEN. Existing images keep their local delivery until republished.',
          'https://images.yourstore.com'
        )}
      </section>
      <section className={`${cardCls} mt-6 space-y-4 p-5 sm:p-6`}>
        <h2 className="text-sm font-medium text-zinc-950">Advanced: checkout admission</h2>
        <p className={hintCls}>
          Bounds how many new checkouts can start at once. Shoppers over the budget get a retryable
          “busy” response; in-progress and duplicate checkouts are never blocked. Changes apply
          within a minute.
        </p>
        {ADMISSION_KEYS.map((key) => {
          const spec = ADMISSION_DEFINITIONS[key];
          return (
            <div key={key}>
              <label className={labelCls} htmlFor={`s-${key}`}>
                {spec.label}
              </label>
              <input
                id={`s-${key}`}
                className={inputCls}
                type="number"
                min={spec.min}
                max={spec.max}
                step={1}
                required
                value={admission[key]}
                onChange={(event) =>
                  setAdmission({ ...admission, [key]: event.target.valueAsNumber })
                }
              />
              <p className={hintCls}>
                Range {spec.min}–{spec.max}; default {spec.default}.
              </p>
            </div>
          );
        })}
      </section>
      <div className="mt-6 flex items-center gap-3">
        <button className={btnPrimary} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>
    </main>
  );
}
