# Analysis of 25a02e0..724bddc

Scope: latest commit 724bddc against parent 25a02e0. 57 files changed, 2318 insertions, 1035 deletions. No application edits. Three independent read-only explorers reviewed admin routes, search, and shared UI. Findings below were checked against source by the primary reviewer. No browser reproduction was performed.

## Findings

1. P1. Empty Products, Collections, and Discounts lists hide their only New buttons. The buttons moved into conditional table toolbars. Empty branches omit those tables. Anchors: web/src/routes/admin/products/index.tsx:322 and 481; collections.tsx:944 and 969; discounts.tsx:318 and 344. Move creation controls outside row-dependent rendering or provide empty-state actions.
2. P2. Drawer transforms constrain nested fullscreen overlays. web/src/components/ui/drawer.tsx:119 permanently applies transform and will-change-transform. Inline fixed descendants in PageEditor.tsx:341, BlogPostEditor.tsx:595, and ExpandableEditor.tsx:68 consequently position against the drawer. Confirmation overlays share this cause. This is inferred from CSS containing-block rules and DOM structure, without browser reproduction.
3. P2. Closing storefront search before first suggestion response loses mounted suggestions. SearchPalette.tsx:145 sets suggestionsAsked before fetching; closing cancels local state application; resolution fills module cache only; reopen skips the effect. The component stays empty until remount. Control-flow finding.
4. P2. SearchPalette.tsx:259 uses aria-modal on a plain div without focus containment or background inertness. Tab can reach background controls. Escape is handled only by the input at 279. Static keyboard/DOM finding.

## Behavior changes

Admin headers, table toolbars, and drawer widths are standardized. Radix sheets are replaced with Base UI drawers. Storefront search opens a palette, shows ten initial published suggestions, debounces queries of at least three characters, and fetches eight FTS product cards plus a hasMore sentinel. Full results retain keyset pagination.

Updated tests explicitly remove SKU lookup from products, inventory, and global search, and email lookup from order discovery. These are intentional capability reductions in this commit. Customer lookup remains in global search. Several product messages still recommend SKU search, and OrderSearchMode still includes the unsupported email variant.

SearchPalette retains old clickable results while a new query is loading. Treat this as a behavior concern until the intended stale-results policy is established.

## Verification

npm run typecheck passed. npm run build passed. npm run lint failed with 29 errors and 10 warnings, chiefly tracked audit fixtures, existing unknown react-hooks/exhaustive-deps rule suppressions, and unused variables. The reviewed application lint failures were present in the parent. Focused checks passed all 18 tests across admin-page-headers, admin-pagination, drawer-migration, and storefront-suggest. The full suite was stopped while unrelated D1 suites were still running; no full-suite verdict is claimed.

New drawer/header/pagination UI tests chiefly check source strings and classes, so passing them does not prove empty-state actions, focus containment, delayed-request lifecycle, or expanded-editor geometry.

## Skill decisions

Prove It Works required running the real build and checks, and labeling static findings separately from browser observations. Type System Discipline identified the unsupported email variant remaining in OrderSearchMode. No application changes, comment deletions, commits, or external issues were created.
