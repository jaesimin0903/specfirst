/*
 * A small time-based memo for server reads. The public Monad testnet RPC allows 15 requests a second; every page
 * and poller goes through here, so ten people watching one request cost one read every few seconds, not ten.
 * Concurrent callers of a key share one in-flight promise. Failures are not cached.
 */

interface Entry {
  at: number;
  value?: unknown;
  pending?: Promise<unknown>;
}

const store = new Map<string, Entry>();
const MAX_ENTRIES = 2000;

export async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const e = store.get(key);
  if (e) {
    if (e.pending) return e.pending as Promise<T>;
    if (now() - e.at < ttlMs) return e.value as T;
  }
  const pending = fn().then(
    (value) => {
      store.set(key, { at: now(), value });
      return value;
    },
    (err) => {
      store.delete(key);
      throw err;
    },
  );
  store.set(key, { at: now(), pending });
  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined && oldest !== key) store.delete(oldest);
  }
  return pending;
}

/** For tests. */
export function clearMemo(): void {
  store.clear();
}
