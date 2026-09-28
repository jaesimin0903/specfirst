import type { CertStatus } from './certStatus';

export interface StatusMeta {
  label: string;
  /** Badge/widget short phrase, e.g. "certified, 7 invariants, 3 days ago". */
  short: string;
  /** CSS custom color token name; only status carries color, everything else stays neutral. */
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

export function statusMeta(status: CertStatus): Omit<StatusMeta, 'short'> {
  switch (status) {
    case 'valid':
      return { label: 'Certified', tone: 'good' };
    case 'superseded':
      return { label: 'Certified, newer version available', tone: 'warn' };
    case 'revoked':
      return { label: 'Revoked', tone: 'bad' };
    case 'partial':
      return { label: 'Partial verification', tone: 'warn' };
    case 'none':
      return { label: 'No certificate', tone: 'neutral' };
  }
}
