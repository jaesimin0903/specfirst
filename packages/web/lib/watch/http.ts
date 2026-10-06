/* Query parsing shared by the watch API routes. */

/** A non-negative integer query value, or null when absent or not one. */
export function intParam(v: string | null): number | null {
  if (v === null || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;
