# Admin UI Redesign — Decision Log

Decisions made during the page-by-page x.ai facelift of the admin.
Newest last. "Skipped" = deliberately not done; "Risk" = what to watch.

## Standing rules

- **Visual language: x.ai.** White background, warm beige `#f7f5f2` panels/tracks
  (rounded-2xl, no border, no shadow), near-black text, muted `#737373`/`zinc-500`
  secondary text, black pill primary buttons, white pills with hairline border,
  orange `#ff4d00` only for alerts, 28px medium page titles, hairline tables.
  No card grids, no data dumps, no form hubs.
- **Surgical facelift only.** One page file per pass. Loaders, server functions,
  URL search params, permissions, and action names/payloads stay byte-identical
  unless a decision below explicitly says otherwise. No shared-token changes in
  `components/ui.tsx` — each page carries local classes so sibling pages don't shift.
- **No new dependencies.** Reuse shadcn components already in
  `web/src/components/ui/` (Button, Input, Select, Toggle, ToggleGroup, Sheet)
  and lucide icons.
- **Page order:** Home → Products → Sidebar → Collections → … one page at a time,
  verified (`typecheck`, `build`, Prettier, targeted tests) before moving on.

## Home (`web/src/routes/admin/index.tsx`)

- "Welcome, {storeName}" header; needs-attention panel first, then sales, then
  recent orders, then shortcut tiles. Everything visible — richer states, not
  hidden content.
- Needs-attention rows are derived only from existing loader fields
  (returns pending, low stock, pending orders, dead webhooks, catalog failures).
  Webhook Replay keeps the same action/handling. "All caught up" row when empty.
- Stat cards deleted: hairline stat row, segmented 7/30/90 pill control (still
  `?days=` links), per-currency rows with a net-vs-refunds bar computed in render.
  Currencies are never combined.
- **Skipped:** sidebar/layout changes, charts/sparklines, new queries, dark mode.
- **Risk:** Home looks x.ai while sibling pages still use the old card style
  until their own passes land.

## Products list (`web/src/routes/admin/products/index.tsx`)

- **Deleted the "Adjust inventory" form under the table.** It was a third, weaker
  copy of stock adjustment (same `stock.adjust` action, hardcoded `restock`
  reason, no note, no replay protection). `/admin/inventory` is the one canonical
  adjustment surface (single + multi-SKU, reasons, replay-safe); the product edit
  page adjusts per variant.
- The table is the page: hairline rows, whole-row click to the editor (row menu
  stops propagation, title stays a focusable link), inventory status dot,
  hand-rolled `…` row menu (Edit, Publish/Move to draft) — no dropdown library.
- **Toolbar is one shadcn row:** joined beige search pill (mode `Select` +
  borderless `Input` + clear ✕, Enter submits — explicit submit, not
  live-as-you-type, because the discovery loader has a "too broad, refine"
  state), status as `ToggleGroup type="single"` (empty deselect ignored),
  sort as one `Select`. The clickable Product column header was folded into it.
- No result count is shown — the loader doesn't provide one and none is invented.
- **Skipped:** bulk selection/actions, column sorting beyond the existing four
  sort values, result counts.
- **Risk:** users who adjusted stock from Products take one extra click via
  Inventory — accepted for one canonical surface. The joined Select+Input focus
  ring sits on the container (`focus-within`); tab order needs a manual check.

## Sidebar (`web/src/components/AdminNav.tsx`)

- 260px borderless white rail matching x.ai: store-initial mark, store switcher,
  14px grey nav items with black active text, black section labels.

## Collections (`web/src/routes/admin/collections.tsx`)

- Stacked form cards replaced by a hairline table. Create and edit both happen
  in wide right **sheets** (`sm:max-w-2xl`, full-width on mobile,
  `onOpenAutoFocus` prevented so Title isn't focused on open). Only one editor
  surface at a time; drafts survive sheet close/reopen. `ConfirmDialog` renders
  inside the edit sheet so the modal sheet can't block it; feedback renders
  inside sheets as well as on the page.
- **Product picker:** portrait `aspect-[4/5]` image tiles for members (matching
  the storefront `ProductCard` ratio) plus a beige `+ Add` tile with a matching
  caption so the row aligns. Add swaps the sheet body to a search view
  (server-driven, 300ms debounce on the existing `q` param, cursor pagination
  via a new `pcursor` param, "too broad" refine message as the empty state).
  Tiles render on first paint from one extra loader query (`memberProducts`);
  a client `knownProducts` map keeps thumbnails across searches.
- **Rejected along the way:** a shadcn Base Combobox picker (planned, never
  implemented) and a modal Command-palette picker (built, then replaced by the
  in-sheet search — no stacked overlays). No `cmdk` dependency was ever added.
- **Type is hidden, not unwound.** The rule engine stays completely intact
  server-side (`parseRule`, catalog publisher, schemas, DB columns, tests).
  The UI drops the Type column/selects; create sends no `kind`/`ruleJson`
  (server defaults to manual); edit round-trips the persisted values so a
  legacy rule collection is never silently converted, and shows the
  "fills itself" note instead of the picker. Re-enabling later is UI-only.
- **SEO description field added** under SEO title — it was already saved via
  the existing payload but had no input. No server change.
- **Featured is two-step:** "Featured on home" toggle pill, rank `Select`
  (positions 1–`MAX_RAILS`) enabled only when on; on defaults to rank 1, off
  clears. Saved through the existing `featuredRankOf` (off = `null`).
- **Slug is not touched.** Immutable on edit (server enforces; covered by
  `tests/admin-safety.test.ts`); create keeps its existing slug field and the
  server's duplicate-slug error. Editable/de-duplicated slugs were proposed
  and retracted by the owner.
- Removed helper text under the tiles ("Use Add to search the catalog…") —
  the UI should explain itself.

### Batched save (edit sheet)

- The two commit buttons (`Save details`, `Save products`) became one pending
  footer: dirty flags derived in render (draft vs persisted row; order-
  insensitive set compare for products — no new state), sticky footer naming
  what's pending ("Unsaved changes — Details · Products") with Discard +
  Save changes. Save runs only the dirty groups sequentially with
  byte-identical payloads, one `router.invalidate()` at the end instead of
  one full loader reload per save. Partial failure: the succeeded group
  commits and goes clean, the failed group stays dirty under an error naming
  it, retry is Save again. Discard deletes that collection's draft entries.
  Closing the sheet with pending changes keeps the drafts (deliberately
  better than a discard-blocker).
- **Skipped:** a combined server-side `collection.save` action (per plan) and
  the signed-in manual pass — no staff session here, so the footer flows,
  single-invalidation network check, and forced-failure retry weren't clicked
  through.
- **Risk:** the honest saving is one loader reload per edit session rather
  than per save; it only becomes significant as collection count grows,
  because each avoided invalidation skips the loader's per-collection
  membership queries and product-discovery reload. On the Cloudflare $5
  Workers plan the win is avoided reads/invocations, not writes.

## Verification limits (applies to all of the above)

- No staff session is available in this environment, so signed-in manual
  flows and screenshots have not been run for any page. Verification so far:
  `npm run typecheck`, `npm run build`, Prettier, and targeted tests
  (`admin-safety`, `admin-product-discovery`, `admin-product-list-2b`).
- Builds must run under Node 24 (`~/.nvm/versions/node/v24.21.0`); the shell's
  default Node 20 fails on an unrelated `node:util` export before compiling.

### Featured-rank duplicate guard (UI only)

- Two collections could both save `featured_rank = 1` (no DB constraint, no
  server clash check), tie-breaking alphabetically on the home rails and
  crowding out a legitimate rank-4 collection. Fixed in the UI only: the
  loader already returns every collection's rank and unsaved drafts already
  live in `editing` state, so taken positions (draft-aware) render disabled
  with the holder's title, toggling Featured on defaults to the first free
  position, and the toggle disables with a caption when all 4 are taken.
- **Skipped:** a partial unique index on `featured_rank` and any server-side
  clash check (extra read per save).
- **Risk:** two tabs saving simultaneously from stale pages can still
  collide; accepted for a single-store admin. Rank swaps require freeing a
  position first.

### Featured control: Switch + segmented position picker

- The toggle-pill + rank dropdown became a shadcn settings row: `Switch`
  (new `web/src/components/ui/switch.tsx`, registry component on the already
  installed `radix-ui` package — no new dependency) with a description line,
  and position as a `ToggleGroup type="single"` (beige track, black active,
  same pattern as the Products status filter). Taken positions are disabled
  numbers with a "Taken: n · Title" caption instead of hidden dropdown items.
  Guard logic (`takenRanksOf`, `firstFreeRank`), dirty tracking, and payloads
  unchanged.

### Edit-sheet close: confirm discard (reverses "drafts survive close")

- Closing the edit sheet with pending changes now opens a "Discard unsaved
  changes?" confirm; confirming deletes the drafts (`editing`/`members`
  entries) and closes, cancelling keeps editing. Clean closes also drop the
  draft entries. Previously drafts silently survived close/reopen — reversed
  by the owner once the pending footer existed.

## Prefix (partial-word) product search

- Title search matched whole FTS tokens only, so `trace` missed "Tracer Tee".
  All three FTS query builders (admin discovery, storefront discovery, catalog
  search) now emit `"term"*` for terms of 3+ characters; shorter terms stay
  exact. No new index (FTS5 prefix is a token-dictionary seek on the existing
  `products_fts`), no new requests: the collections picker keeps its 300ms
  debounce, admin products and storefront stay submit-based, and the existing
  candidate caps/refine state bound the worst case. The picker shows a spinner
  over stale results while a debounced search is in flight.
- **Skipped:** a dedicated search endpoint for the picker (the collections
  loader reload — collections + membership queries — is the real cost of a
  picker search, not the FTS lookup; the debounce rations it), mid-word
  substring matching, and live typing on submit-based pages.

## Admin feedback is a toast

- `AdminActionFeedback` was an inline sticky `Alert` that sat in the page (and
  inside both collection sheets) until the next action. It is now a fixed
  bottom-center pill — green on success, red on error, `z-[60]` above sheets —
  that auto-dismisses after 3 seconds (dismissal tracked by value identity, so
  SSR still renders it and a repeated identical message re-shows). Same props
  everywhere; Collections dropped its two in-sheet renders.
