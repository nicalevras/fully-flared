# Replacement admin design study

This replaces the rejected first visual study. It is a disposable, built React prototype using the existing shadcn Button, Input, Badge, Table and Sheet source through the @ alias, Radix Dialog, Lucide and Geist 400/500. Application files are read, not modified. Data, permissions and commerce actions are simulated.

Open http://localhost:8900/design-v2/dist/index.html while serving .audit/gate0 on port 8900. A production static build is bundled under dist; this is not a deployed application or evidence of production commerce correctness.

## Rebuild

From the repository root with the existing web dependencies installed:

```
ln -s "$PWD/web/node_modules" .audit/gate0/design-v2/node_modules
node web/node_modules/vite/bin/vite.js build --config .audit/gate0/design-v2/vite.config.ts
node web/node_modules/typescript/bin/tsc --project .audit/gate0/design-v2/tsconfig.json
python3 -m http.server 8900 --bind 127.0.0.1 --directory .audit/gate0
```

Skip the symlink command if it already exists. No new runtime package or infrastructure was added. Bundled fonts and scripts are served locally.

## Visual direction

White canvas, sparse sidebar, Geist typography, thin horizontal rules, restrained statuses and black primary actions. No summary metric cards, slogans, decorative glyph imagery or conspicuous study toolbar. Footer Design study opens layout A/B, storage mode and scenario controls.

A uses dedicated record workspaces. B uses the same editor inside a real shadcn Sheet. Both retain a per-record content action island. Operational shipment and return actions stay separate.

## Task scripts

- Products, search FF-TEE-BLK-M, open Heavyweight T-Shirt, change Description, Review, Publish changes.
- Add product, enter Title, Add options, inspect six illustrative rows, Save draft.
- Orders, search alex@example.com, open #1048, Mark as shipped, optionally enter Tracking number, Confirm shipment.
- Orders, select #1048 and #1047, Packing slips, inspect both slips. No actual carrier purchase or email.
- Orders, Returns, #1045, Review return, Approve return. Approved returns wait for returned items; no automatic refund or stock adjustment.
- Design study, choose B, close study, open a record. Product review/publish controls stay inside the Sheet's modal scope. Escape and close restore focus to the initiating row.
- Design study, IndexedDB recovery, edit an existing product, wait for Saved on this device, reload, reselect IndexedDB recovery, reopen the same product. The exact edited description recovers.
- At mobile width, Open navigation, select Orders, open a record. Escape closes the Radix navigation Sheet.

## Limitations

Eight products and five orders are illustrative. Search is in-memory, pagination disabled, media control a placeholder, six variants a fixed demonstration and pricing not editable. This does not implement the product creation contract or prove unique SKU creation. Samples include no real customer data.

IndexedDB uses ff-gate0-v2-design-only with a fixed demo-owner key. It demonstrates recovery, not real identity switching, migrations, eviction, cross-tab coordination or atomic server conflicts. Scenario selections illustrate failures and do not inject production failures. A successful save explicitly says Saved in prototype, not globally Live.

Settings, Inventory, Content and Customers navigation are labeled out-of-study entry points. They are not feature implementations. Visual acceptance remains the owner's decision. Focused browser verification is recorded separately; no automated WCAG certification is claimed.
