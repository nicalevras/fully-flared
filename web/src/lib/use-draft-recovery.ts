import { useEffect, useRef, useState } from 'react';
import {
  draftKey,
  evaluateRecovery,
  fieldsSignature,
  indexedDbDraftStore,
  parseDraft,
  serializeDraft,
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
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const serverSignature = fieldsSignature(args.serverFields);
  const currentSignature = fieldsSignature(args.currentFields);
  const currentFieldsRef = useRef(args.currentFields);
  currentFieldsRef.current = args.currentFields;

  useEffect(() => {
    let live = true;
    void store.get(key).then((raw) => {
      if (!live) return;
      const draft = parseDraft(raw, args.staffId, args.entityType, args.entityId);
      if (!draft) return;
      const decision = evaluateRecovery(draft, args.baseUpdatedAt, args.serverFields);
      if (decision.action === 'offer') {
        setRecovery({ draft, stale: decision.stale });
      } else {
        void store.remove(key);
      }
    });
    return () => {
      live = false;
    };
    // Recovery is evaluated once, against the server state the page loaded with.
  }, [key]);

  useEffect(() => {
    if (currentSignature === serverSignature) {
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
      setRecovery(null);
      void store.remove(key);
    },
    clearDraft: () => {
      setRecovery(null);
      setSavedAt(null);
      void store.remove(key);
    },
    markRecovered: () => setRecovery(null),
  };
}
