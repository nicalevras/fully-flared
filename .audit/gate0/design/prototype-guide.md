# Compare merchant workspaces

Open `index.html` through a local HTTP server. This is a disposable design artifact, not application code. Every record is simulated. No request reaches Fully Flared, Stripe, a carrier or Cloudflare.

The prototype is dependency-free. It approximates the existing shadcn neutral visual language with native HTML controls. It does not install or embed production shadcn components. Production implementation must reuse the configured components after approval.

## Select a direction

The first control switches between A, Full workspaces, and B, Contextual panels. The same product and order tasks are available in both. Use the same viewport and task script for a comparison.

A record opens a dedicated workspace in A. In B it opens an accessible side panel while the list remains visible. Escape closes an unchanged panel. Dirty record navigation prompts before discarding. Native modal dialogs retain focus while open. The side panel traps Tab, and closing returns focus to the invoking record button where it still exists.

Desktop uses a sparse sidebar. At 760 pixels and below, Menu opens the navigation drawer. Tables scroll horizontally instead of hiding financial or inventory columns. Product editors become one column. The floating action island stays within the viewport.

## Run the same tasks in each direction

| Task | Exact path | Observable pass condition |
|---|---|---|
| Find a SKU | Products, search `FF-TEE-BLK-M`, open Everyday Heavyweight Tee | The matched record opens with its name and description. |
| Change product content | Edit Product name or Description, select Review | The modal shows the previous value and proposed value. |
| Publish once | Review, Publish changes | One simulated submission displays Accepted, then Delivered. The message distinguishes delivery from worldwide visibility. |
| Create six variants | Add product, enter a name, Add options, Generate 6 variants | Six combinations with distinct illustrated SKUs appear. Save draft creates a simulated draft product. |
| Discard edits | Open product, change Description, select Discard | The original value returns and the island disappears. |
| Recover a device draft | Select IndexedDB recovery, open product, edit Description, wait one second, reload, reopen the same product | The changed description returns and a recovered-draft notification appears. |
| Compare memory mode | Select Memory Save/Publish, edit, select Orders | A leave dialog explains that edits exist only in this tab. |
| Find an order | Orders, search `alex@example.com`, open #FF1048 | The customer and paid order details appear. |
| Pack orders | Orders, select #FF1048 and #FF1047, Print packing slips | Two packing slips appear. Print uses the browser print dialog. |
| Ship an order | Open #FF1048, Mark as shipped, optionally enter tracking, Confirm shipment | The order becomes Shipped and a simulated notification message appears. |
| Review a return | Orders, Returns, open #FF1045, Review return, Approve return | The order becomes Return approved. The message explicitly says no refund or stock adjustment occurred. |
| Navigate on mobile | At 390 pixels, Menu, Orders, open a record | Navigation closes and the record remains usable without clipped action buttons. |

Counts, elapsed time and task completion evidence must come from a browser run. The static guide does not claim these tests passed.

## Exercise the failure states

The Scenario control deliberately selects a state. These are design demonstrations, not injected application failures.

- Loading shows table skeletons with a busy state.
- Empty replaces the table with a next action.
- Permission denied removes record access from the displayed list.
- Success displays a confirmation banner.
- Error displays a load warning. A product publish or shipment confirmation then fails without clearing the simulated edits.
- Uncertain submission displays an unknown-outcome warning. Product Publish offers Check recorded outcome rather than an immediate blind retry. Shipment confirmation keeps the outcome unresolved.
- Conflict blocks product publish and offers Keep my draft or Reload latest. The illustrated revisions are simulated.
- Storage unavailable explains that the tab holds the edits and offers a JSON export. IndexedDB writes deliberately fail in this scenario.

## Compare draft designs

Memory mode and IndexedDB mode use the same Publish action. The latter adds device recovery only. The prototype contains no server autosave in either mode and cannot measure publication savings.

IndexedDB uses the dedicated `ff-gate0-design-only` database and a fixed demo-owner plus record key. It is isolated from the application database. It does not implement real identity changes, logout cleanup, migration, cross-tab reconciliation, browser eviction or durable revision checking. Those remain explicit implementation requirements if persistent drafts are selected.

Recommended initial direction is A, full workspaces. It exposes the product fields and order next action without maintaining a second compact editor. B is credible for repeated order triage, but this prototype alone does not establish faster task completion. Compare browser evidence before deciding.

## Record the limits

- The dataset has five illustrated products and four orders. Search is local substring matching. It does not prove indexed D1 search, scale, permissions or production privacy.
- Variant generation always produces the illustrated three sizes by two colors. The option inputs do not define a real variant engine. Price and stock edits are outside this content draft.
- Photo controls are entry points with placeholders. There is no media upload, sanitizer or product-rich-text implementation.
- All publication stages are timers. They do not prove idempotency, reference delivery, cache purging or shopper freshness.
- Shipment and return transitions update browser memory only. Tracking is illustrative and does not create a shipment record.
- List summaries are fixed design content and do not recompute after every simulated mutation. Pagination controls are disabled because all demo records are visible.
- Only per-record submission is designed. There is no global Publish all or real bulk mutation.
- Browser verification and screenshots belong in the Gate 0 evidence directory and must identify which direction, viewport, storage mode and scenario were used.
