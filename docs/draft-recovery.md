# Draft recovery (Phase 12): disabled for this release

Status: implemented and race-hardened, but not enabled.

The recovery hook (`web/src/lib/use-draft-recovery.ts`) and its storage
contract passed unit tests, including the cleanup-ordering guard. The
release gate also required proof in a real browser with real IndexedDB:
seed a device draft, reload the editor, and show the recovery offer
cannot lose the draft. That browser proof could not be run in the
executing host, so per the FF-06 hard gate the feature ships disabled:
neither the Blog nor the Pages editor wires the hook, and no draft is
written to or read from the device.

Re-enabling requires the browser scenario above, run three consecutive
times, plus sign-out isolation, staff scoping, and corrupt or
version-mismatched draft checks in the same browser.
