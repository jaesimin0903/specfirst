import type { AttestationRecord } from '../board/types';
import type { LiveAttestation } from './registry';

/*
 * The check badge: /badge/check/<chainId>/<address>.svg. It states only what CheckAttestationRegistry holds for the
 * vault, because a badge is copied into places where nobody can see the report behind it. The certificate badge
 * at /badge/<address> is a different product (spec certificates) and stays as it is.
 *
 * Colors follow the board: seal blue means recorded onchain and all passed, the signal red means a property
 * failed, and everything else stays in neutral ink.
 */

export type CheckBadgeState = 'compliant' | 'mismatch' | 'partial' | 'not-attested' | 'unavailable';

export interface CheckBadge {
  state: CheckBadgeState;
  /** "compliant, 30/30 pass" */
  text: string;
  attestationId: string | null;
}

export function checkBadgeOf(live: LiveAttestation): CheckBadge {
  if (live.kind === 'unread') return { state: 'unavailable', text: 'status unavailable', attestationId: null };
  if (live.kind === 'none') return { state: 'not-attested', text: 'not attested', attestationId: null };
  return fromRecord(live.record);
}

function fromRecord(r: AttestationRecord): CheckBadge {
  const c = r.counts;
  const total = c.pass + c.fail + c.inconclusive + c.notApplicable;
  if (r.status === 'Revoked' || r.status === 'None') return { state: 'not-attested', text: 'attestation revoked', attestationId: r.id };
  if (c.fail > 0) return { state: 'mismatch', text: `mismatch, ${c.fail} of ${total} fail`, attestationId: r.id };
  // isCompliant is the registry's own word; when it could not be read, the counts say the same thing.
  const compliant = r.compliant ?? (total > 0 && c.pass === total);
  if (compliant) return { state: 'compliant', text: `compliant, ${c.pass}/${total} pass`, attestationId: r.id };
  return { state: 'partial', text: `partly checked, ${c.pass}/${total} pass`, attestationId: r.id };
}

const TONE: Record<CheckBadgeState, { bg: string; fg: string }> = {
  compliant: { bg: '#1e5aa8', fg: '#ffffff' },
  mismatch: { bg: '#cf3a1d', fg: '#ffffff' },
  partial: { bg: '#4f5f6b', fg: '#ffffff' },
  'not-attested': { bg: '#e6eae9', fg: '#13202a' },
  unavailable: { bg: '#e6eae9', fg: '#4f5f6b' },
};

export const CHECK_BADGE_LABEL = 'specfirst erc-4626';
const CHAR_WIDTH = 6.4;
const PADDING = 8;
const HEIGHT = 20;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function renderCheckBadgeSvg(b: CheckBadge): string {
  const tone = TONE[b.state];
  const lw = Math.round(CHECK_BADGE_LABEL.length * CHAR_WIDTH + PADDING * 2);
  const vw = Math.round(b.text.length * CHAR_WIDTH + PADDING * 2);
  const w = lw + vw;
  const label = esc(CHECK_BADGE_LABEL);
  const text = esc(b.text);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${HEIGHT}" role="img" aria-label="${label}: ${text}">
  <title>${label}: ${text}</title>
  <clipPath id="r"><rect width="${w}" height="${HEIGHT}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="${HEIGHT}" fill="#13202a"/>
    <rect x="${lw}" width="${vw}" height="${HEIGHT}" fill="${tone.bg}"/>
  </g>
  <g text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${lw / 2}" y="14" fill="#ffffff">${label}</text>
    <text x="${lw + vw / 2}" y="14" fill="${tone.fg}">${text}</text>
  </g>
</svg>`;
}
