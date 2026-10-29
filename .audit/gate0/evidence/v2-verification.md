# Replacement browser verification

This section applies only to design-v2, the actual shadcn replacement. The owner has not yet approved its visual direction. All commerce data and actions are simulated.

## Verified in the browser

- Exact SKU FF-TEE-BLK-M locates Heavyweight T-Shirt. The product opens in a full editor.
- Editing Description opens a per-record island. Review displays the original and changed text. Publish changes displays Saved in prototype and clears the island.
- Add product, enter Title, Add options yields six illustrated rows (seven table rows including its header), then Save draft succeeds. This is a fixed matrix, not a production variant generator.
- Order email alex@example.com locates #1048. Tracking input and Confirm shipment produce Shipped without a real customer email.
- Return #1045 names Sam Rivera correctly. Approval remains separate from refund/restock and waits for returned items.
- IndexedDB saves a description and recovers the exact string Gate 0 v2 draft recovery check after reload. See v2-draft-recovery.txt.
- In B, product review/publish works inside the actual Sheet on desktop and mobile. The first placement outside the modal was inaccessible and was corrected before handoff.
- Closing the mobile product Sheet restores focus to the initiating Heavyweight T-Shirt button. Browser inspection recorded document width390px matching viewport390px.
- Products and Orders have desktop/tablet/mobile capture sets. At390px, essential product status/stock/price and order fulfillment/total remain visible without sideways table scrolling. Secondary fields remain in record details.

## Limits

No screen-reader certification, full WCAG audit, merchant study, real upload, carrier integration, actual email, durable operational retry or server conflict implementation is established by the prototype. Feature PRs must prove these against real application surfaces. In-memory simulated saves do not measure backend savings; the resource experiment provides that evidence separately.

The comparison demonstrates both layouts can complete the basic task. It does not establish a measured speed advantage for Sheets. Full workspaces remain the proposed default, subject to owner visual approval.

Additional final checks confirmed two selected packing slips, loading/empty/permission/error screens, conflict and uncertain-outcome dialogs, and Cmd+K search focus. Responsive bounds in v2-responsive-checks.json show no document overflow at1440,834,390px for either list. These remain prototype behaviors, not server guarantees.
