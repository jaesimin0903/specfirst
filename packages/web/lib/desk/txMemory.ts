import { browserStorage } from './burner';

/*
 * The transaction that paid for a request. requestOf does not record it, so the page that sent it remembers it
 * for the request page (the ?tx= query parameter carries it too).
 */

function key(desk: string, id: string): string {
  return `specfirst:desk:${desk.toLowerCase()}:tx:${id}`;
}

export function rememberRequestTx(desk: string, id: string, hash: string): void {
  try {
    browserStorage()?.setItem(key(desk, id), hash);
  } catch {
    // Only a convenience.
  }
}

export function recallRequestTx(desk: string, id: string): string | null {
  try {
    const v = browserStorage()?.getItem(key(desk, id)) ?? null;
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}
