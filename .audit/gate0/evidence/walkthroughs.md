# Browser walkthrough evidence

## Baseline and method

Browser drove unchanged remote main 6339f228c3dd7b9a71442d0983b73695bdab306e from an archived local copy on port 8899. All data is disposable and uses invalid test email domains. The installed dependencies were reused, not independently installed from the archived lockfile. Vite development rendering is not production performance evidence.

Created local users and password hashes using the existing HTTP test-fixture convention. Sessions were marked 2FA-verified only in the disposable database. This permits role/UI inspection but does not test the real enrollment or authenticator challenge. No production authentication changed. Shipment generated the existing local outbox path; the UI's email success message is not proof of external email delivery.

Captured Products, product editor/inventory, Orders, Customers, Blog and Pages at desktop 1440×1000, tablet 834×1112 and mobile 390×844. Screenshots are full-page and can be taller than the viewport. Each baseline image has a matching DOM snapshot. No dedicated Inventory route currently exists; its current editing surface is the product editor.

## Current merchant tasks

| Task | Browser steps and outcome | Obstacle | Evidence |
|---|---|---|---|
| Find SKU | Open Products, inspect list, open product editor to see its SKU | No SKU search control; must know product or browse pages. Exact-SKU task not supported by list. | baseline-products-desktop.jpg; baseline-inventory-editor-desktop.txt |
| Edit content | Products → Edit → change Description → Save product → Product saved | Separate saves for details, variants and associations; no combined review | baseline-product-save-result.jpg; requests-content-edit.json |
| Create six variants | Inspect Add product and per-product New SKU controls | Creation accepts one SKU; additional variants require separate manual entries. Full six-variant baseline task not executed. | baseline-product-editor-desktop.jpg |
| Find order by email | Orders → visually locate buyer → order number | No email search or unfulfilled filter; tested on three records only | baseline-orders-desktop.jpg; requests-order-lookup.json |
| Ship | Open FF-1002 → enter tracking → Mark as shipped → shipped status and tracking | Explicit workflow works; no batch selection or packing slip entry point | baseline-shipment-result.jpg |
| Review return | Open FF-1003 → inspect reason, approval/rejection and refund restriction | Return actions also live on Orders list. Approval/refund not executed against baseline fixture. | baseline-return-review-desktop.jpg |
| Guest buyer | Inspect Customers with three guest/account sample orders | Directory lists user accounts, omits guest-only buyers | baseline-customers-desktop.jpg |
| Content | Open Blog and Pages | Blog empty state; Pages exposes raw HTML editing | baseline-blog-desktop.jpg; baseline-pages-mobile.jpg |
| Role denial | Set disposable fixture actor to warehouse, open Customers, then restore owner | Server denies user.list, but screen shows generic Something went wrong and permission code rather than merchant guidance | baseline-permission-denied.jpg; baseline-permission-denied.txt |
| Missing record | Open deliberately absent product ID | Friendly not-found page and Back to products link work | baseline-missing-record-error.jpg |

One local content-edit trace window recorded 14 GET root spans, 1 POST and 1 queue invocation. One order-navigation window recorded 8 GET and no POST/queue. These include related loader/realtime activity and Vite effects. They exclude static assets and are not a full HAR or deployed request bill. No production request-efficiency ratio is claimed.

## Rejected first prototype tasks and comparison

The owner rejected this entire visual direction. Results in this section apply only to the retained first exploration under design/, not the replacement or an approved production design. Prototype actions are simulated, except IndexedDB persistence in its isolated demo database. Source is design/index.html and task scripts are design/prototype-guide.md. It approximates shadcn using native HTML; no production component code was installed.

| Task | A full workspace | B contextual panel | Result |
|---|---|---|---|
| Exact SKU → record | Enter SKU, open result | Enter SKU, open result | Both pass on demo dataset; 2 input/action steps |
| Email → shipment | Enter email, open order, Mark as shipped, Confirm | Same path | Both pass in simulation; 4 steps excluding optional tracking |
| Content review | Edit description, Review, inspect diff, Publish changes | Same editor reused in panel | A publish path exercised; B edit and device persistence exercised |
| Six variants | Add product, name, Add options, Generate 6 variants, Save draft | Same content surface in panel | A six-row generation and draft creation passed; fixed illustrative matrix, not a real option engine |
| Packing slips | Select 2 orders, Print packing slips, inspect 2 slips | Same dialog | A passed; system print dialog and printed PDF not verified |
| Return | Returns → record → Review return → Approve | Same editor | A passed; approved state has no refund or restock |
| Escape/focus | Native dialogs | Escape closes panel and returns focus to original row | Panel focus return failed first pass, fixed in prototype and passed retest |
| Mobile | Menu → Orders → record | Panel fits 390px and keeps action buttons within viewport | Both navigation paths exercised; B panel bounds in prototype-panel-mobile-check.json |

No statistically meaningful speed comparison or merchant usability study occurred. Both directions use the same number of interactions for the two comparable tasks. Therefore this first exploration did not demonstrate a benefit sufficient to outweigh panel focus and narrow-layout complexity. Its suggested selection of A was superseded by the owner rejecting the design. The replacement has separate [browser verification](v2-verification.md) and [responsive evidence](v2-responsive-checks.json). Its visual acceptance remains with the owner. Reserve sheets for narrow immediate actions such as stock adjustments; do not duplicate the full editor.

## First-prototype draft and failure behavior

IndexedDB demo saved a changed description, survived reload, and recovered the exact string `Recoverable Gate 0 content draft`. See prototype-draft-recovery.txt and prototype-device-draft-recovered.jpg. Memory mode displayed a leave-with-unpublished-changes dialog. Both modes use one simulated submission; publisher savings come from fewer commits, not device storage.

Captured loading, empty, permission denied, success, error and uncertain list scenarios. Product publish error preserves edited fields. Unknown outcome opens Check recorded outcome before a retry. Conflict opens base/current revision review without overwriting the draft. Storage-unavailable state offers export and keep-tab guidance. These are deliberately selected prototype states, not injected application failures or working production concurrency.

Actual baseline denied, missing-record, empty and success states were captured. Baseline slow-network loading and lost-response recovery were not fault-injected. Prototype states fill the design specification, not that runtime evidence gap.

## First-prototype accessibility checks and limits

Browser inspected labeled inputs and dialogs, Escape dismissal, focus return, mobile navigation and action bounds. Prototype contrast was tightened after inspection by darkening muted text to #666. Native dialog trapping and custom panel trapping are exercised during review. This is a focused manual check, not an automated WCAG certification or screen-reader test. Production must use existing shadcn/Radix behavior and repeat checks on real components.

Prototype-only issues corrected during walkthrough: return dialog initially named the wrong customer; approved return initially exposed fulfillment again; new record inherited prior publication copy; panel focus return targeted a detached row. These are not application-code changes.

## Replacement evidence

The actual-shadcn replacement is documented and verified separately in [v2-verification.md](v2-verification.md). The [gallery](gallery.html) leads with v2 and puts the rejected first exploration in a collapsed, explicitly labeled section. Original prototype task results above do not certify the replacement.
