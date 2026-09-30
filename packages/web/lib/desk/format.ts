import { formatEther } from 'viem';

/*
 * Money and time for the desk pages. Wei travels as decimal strings in API responses (JSON has no bigint).
 */

export function toWei(v: string | bigint | number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  const s = String(v);
  return /^\d+$/.test(s) ? BigInt(s) : null;
}

/**
 * "0.1", "0.0231", "12.5": ether units with at most `decimals` fraction digits, trailing zeros dropped. Amounts
 * that are not zero but round to zero show as "<0.0001" so a small gas bill never reads as free.
 */
export function formatMonAmount(wei: bigint, decimals = 4): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const [whole = '0', frac = ''] = formatEther(abs).split('.');
  const cut = frac.slice(0, decimals).replace(/0+$/, '');
  let text: string;
  if (abs > 0n && whole === '0' && !cut) text = `<0.${'0'.repeat(Math.max(decimals - 1, 0))}1`;
  else text = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cut ? `.${cut}` : ''}`;
  return negative ? `-${text}` : text;
}

export function formatMon(wei: bigint | null, decimals = 4): string {
  return wei === null ? 'unknown' : `${formatMonAmount(wei, decimals)} MON`;
}

/** "42 s", "3 min", "2 h 5 min", "3 days". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** ISO 8601 or unix seconds (string or number) to ISO; null when it is neither. */
export function toIso(v: string | number | bigint | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return new Date(Number(v) * 1000).toISOString();
  if (typeof v === 'number' || /^\d+$/.test(v)) {
    const n = Number(v);
    // Seconds; a value that already looks like milliseconds is taken as such.
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function percent(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null;
  return Number((numerator * 10000n) / denominator) / 100;
}
