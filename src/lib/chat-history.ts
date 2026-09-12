// The conversation lives only in this browser; the server keeps no copy. IndexedDB rather than
// localStorage because an attached image can outgrow localStorage's few megabytes, and structured
// clone stores each entry as it is. Every call rejects where storage is unavailable, such as some
// private windows, and callers carry on with an unsaved chat.
let database: Promise<IDBDatabase> | undefined;
const open = () => database ??= new Promise((resolve, reject) => {
  const request = indexedDB.open('assistant', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('conversation');
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const request = action((await open()).transaction('conversation', mode).objectStore('conversation'));
  return new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
};

// ponytail: one record for the whole thread, last tab to write wins; per-entry rows if two open tabs ever matter.
export const loadConversation = async <T>() => (await run('readonly', store => store.get('entries')) as T[] | undefined) ?? [];
export const saveConversation = (entries: unknown[]) => run('readwrite', store => store.put(entries, 'entries'));
export const clearConversation = () => run('readwrite', store => store.delete('entries'));
