export const DRAFT_FORMAT_VERSION = 1;

export type DraftEntityType = 'post' | 'page';

export type DraftRecord = {
  version: number;
  staffId: string;
  entityType: DraftEntityType;
  entityId: string;
  baseUpdatedAt: string | null;
  savedAt: number;
  fields: Record<string, string>;
};

export function draftKey(staffId: string, entityType: DraftEntityType, entityId: string): string {
  return `ff-draft:v${DRAFT_FORMAT_VERSION}:${staffId}:${entityType}:${entityId}`;
}

export function serializeDraft(record: DraftRecord): string {
  return JSON.stringify(record);
}

export function parseDraft(
  raw: string | null,
  staffId: string,
  entityType: DraftEntityType,
  entityId: string
): DraftRecord | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== DRAFT_FORMAT_VERSION) return null;
    if (record.staffId !== staffId || record.entityType !== entityType) return null;
    if (record.entityId !== entityId) return null;
    if (typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt)) return null;
    if (record.baseUpdatedAt !== null && typeof record.baseUpdatedAt !== 'string') return null;
    if (typeof record.fields !== 'object' || record.fields === null || Array.isArray(record.fields))
      return null;
    const fields: Record<string, string> = {};
    for (const [key, fieldValue] of Object.entries(record.fields)) {
      if (typeof fieldValue !== 'string') return null;
      fields[key] = fieldValue;
    }
    return {
      version: DRAFT_FORMAT_VERSION,
      staffId,
      entityType,
      entityId,
      baseUpdatedAt: record.baseUpdatedAt as string | null,
      savedAt: record.savedAt,
      fields,
    };
  } catch {
    return null;
  }
}

export function fieldsSignature(fields: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((key) => [key, fields[key]])
  );
}

export type RecoveryDecision =
  { action: 'offer'; stale: boolean } | { action: 'discard'; reason: 'same-as-current' };

export function evaluateRecovery(
  draft: DraftRecord,
  serverUpdatedAt: string | null,
  currentFields: Record<string, string>
): RecoveryDecision {
  if (fieldsSignature(draft.fields) === fieldsSignature(currentFields)) {
    return { action: 'discard', reason: 'same-as-current' };
  }
  const stale =
    draft.baseUpdatedAt !== null &&
    serverUpdatedAt !== null &&
    serverUpdatedAt > draft.baseUpdatedAt;
  return { action: 'offer', stale };
}

export type DraftStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<boolean>;
  remove(key: string): Promise<void>;
};

export function memoryDraftStore(): DraftStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
      return true;
    },
    async remove(key) {
      map.delete(key);
    },
  };
}

const DB_NAME = 'fully-flared-admin';
const STORE_NAME = 'drafts';

function openDraftDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbRequest<T>(run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDraftDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const request = run(tx.objectStore(STORE_NAME));
      request.onsuccess = () => {
        db.close();
        resolve(request.result ?? null);
      };
      request.onerror = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export function indexedDbDraftStore(): DraftStore {
  return {
    async get(key) {
      const value = await idbRequest<IDBValidKey>((store) => store.get(key));
      return typeof value === 'string' ? value : null;
    },
    async set(key, value) {
      const result = await idbRequest<IDBValidKey>((store) => store.put(value, key));
      return result !== null;
    },
    async remove(key) {
      await idbRequest<undefined>((store) => store.delete(key));
    },
  };
}
