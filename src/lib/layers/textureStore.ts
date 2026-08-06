// Persistent storage for user-uploaded texture layers (IndexedDB).

const DB_NAME = "gridlook-textures";
const STORE_NAME = "textures";

export type TStoredTexture = {
  id: string;
  name: string;
  blob: Blob;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = action(tx.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

export async function saveTexture(
  name: string,
  blob: Blob
): Promise<TStoredTexture> {
  const texture: TStoredTexture = { id: crypto.randomUUID(), name, blob };
  await withStore("readwrite", (store) => store.put(texture));
  return texture;
}

export async function loadTextures(): Promise<TStoredTexture[]> {
  return withStore("readonly", (store) => store.getAll());
}

export async function getTexture(
  id: string
): Promise<TStoredTexture | undefined> {
  return withStore("readonly", (store) => store.get(id));
}

export async function deleteTexture(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}
