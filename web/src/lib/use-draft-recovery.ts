import { useEffect, useRef, useState } from 'react';
import {
  draftKey,
  evaluateRecovery,
  fieldsSignature,
  indexedDbDraftStore,
  parseDraft,
  serializeDraft,
  shouldRemoveDraftOnClean,
  DRAFT_FORMAT_VERSION,
  type DraftEntityType,
  type DraftRecord,
  type DraftStore,
} from './draft-recovery';

export function useDraftRecovery(args: {
  staffId: string;
  entityType: DraftEntityType;
  entityId: string;
  baseUpdatedAt: string | null;
  serverFields: Record<string, string>;
  currentFields: Record<string, string>;
}) {
  const storeRef = useRef<DraftStore | null>(null);
  if (!storeRef.current) storeRef.current = indexedDbDraftStore();
  const store = storeRef.current;
  const key = draftKey(args.staffId, args.entityType, args.entityId);
  const [recovery, setRecovery] = useState<{ draft: DraftRecord; stale: boolean } | null>(null);
  // FF-06: the cleanup effect below must never remove a draft before the
  // recovery read for this entity has settled, nor while an offer is shown.
  const readSettledRef = useRef(false);
  const recoveryShownRef = useRef(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const serverSignature = fieldsSignature(args.serverFields);
  const currentSignature = fieldsSignature(args.currentFields);
  const currentFieldsRef = useRef(args.currentFields);
  currentFieldsRef.current = args.currentFields;

  useEffect(() => {
    let live = true;
    readSettledRef.current = false;
    recoveryShownRef.current = false;
    void store
      .get(key)
      .then((raw) => {
        if (!live) return;
        const draft = parseDraft(raw, args.staffId, args.entityType, args.entityId);
        if (!draft) return;
        const decision = evaluateRecovery(draft, args.baseUpdatedAt, args.serverFields);
        if (decision.action === 'offer') {
          recoveryShownRef.current = true;
          setRecovery({ draft, stale: decision.stale });
        } else {
          void store.remove(key);
        }
      })
      .finally(() => {
        readSettledRef.current = true;
      });
    return () => {
      live = false;
    };
    // Recovery is evaluated once, against the server state the page loaded with.
  }, [key]);

  useEffect(() => {
    if (currentSignature === serverSignature) {
      // Wait for the recovery read, and never delete a draft whose
      // recovery offer is on screen.
      if (
        !shouldRemoveDraftOnClean({
          readSettled: readSettledRef.current,
          recoveryShown: recoveryShownRef.current,
        })
      )
        return;
      void store.remove(key);
      return;
    }
    const timer = setTimeout(() => {
      const now = Date.now();
      void store
        .set(
          key,
          serializeDraft({
            version: DRAFT_FORMAT_VERSION,
            staffId: args.staffId,
            entityType: args.entityType,
            entityId: args.entityId,
            baseUpdatedAt: args.baseUpdatedAt,
            savedAt: now,
            fields: currentFieldsRef.current,
          })
        )
        .then((ok) => {
          if (ok) setSavedAt(now);
        });
    }, 600);
    return () => clearTimeout(timer);
  }, [currentSignature, key]);

  return {
    recovery,
    savedAt,
    discardRecovery: () => {
      recoveryShownRef.current = false;
      setRecovery(null);
      void store.remove(key);
    },
    clearDraft: () => {
      recoveryShownRef.current = false;
      setRecovery(null);
      setSavedAt(null);
      void store.remove(key);
    },
    markRecovered: () => {
      recoveryShownRef.current = false;
      setRecovery(null);
    },
  };
}
