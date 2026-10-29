# First admin workflow browser verification

Baseline main6339f228 at localhost:8899. Head at127.0.0.1:8902 uses separate disposable DB and cookies. No production access.

- Capture actual Orders at1440,768,390. Check320 and390x480 mobile menu reachability.
- Drawer open, Tab/ShiftTab, Escape, overlay, close, active link, detail route, pagination, back, resize to desktop.
- Verify default dismissal returns focus to visible trigger; after switching to rail focus does not remain trapped on a hidden control.
- Skip to content reaches post-navigation content target.
- Warehouse sees Orders, not Customers or Settings/Home; Media stays staff-visible. Owner sees all. Server role gates remain unchanged.
- Capture success status on disposable return action and error alert after stale return deletion; confirm no green completed refund signal for transport-success pending messages.
- Five identical drawer open/close repetitions add zero local Worker root spans; navigation comparison counts loader RPCs with dev/telemetry limitations.
- Count one active realtime socket; preserve busy/disabled rules, confirmation, refund request IDs and existing invalidation behavior.

Permission and2FA fixture setup follows the existing verify-http convention and does not prove authenticator enrollment. No real email, payment, refund or production write occurs. Resource comparisons prove local request counts, not deployed CPU or checkout capacity.
