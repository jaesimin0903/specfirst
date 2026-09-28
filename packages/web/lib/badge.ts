import type { CertStatus } from './certStatus';
import { timeAgo } from './format';

export interface BadgeInput {
  status: CertStatus;
  passed: number;
  total: number;
  issuedAt: string | null;
  now?: Date;
}

const TONE_COLOR: Record<CertStatus, string> = {
  valid: '#1a7f4b',
  superseded: '#8a6d00',
  partial: '#8a6d00',
  revoked: '#a3282e',
  none: '#5b6270',
};

/** "certified, 7 invariants, 3 days ago" per docs/plan.md 3.8's badge text format. */
export function badgeText(input: BadgeInput): string {
  const { status, passed, total, issuedAt, now } = input;
  switch (status) {
    case 'valid':
      return `certified, ${total} invariant${total === 1 ? '' : 's'}${issuedAt ? `, ${timeAgo(issuedAt, now)}` : ''}`;
    case 'superseded':
      return `certified, ${total} invariant${total === 1 ? '' : 's'}, newer version available`;
    case 'partial':
      return `partial, ${passed}/${total} invariants`;
    case 'revoked':
      return 'revoked';
    case 'none':
      return 'no certificate';
  }
}

const CHAR_WIDTH = 6.6;
const LABEL = 'specfirst';
const PADDING = 10;
const HEIGHT = 20;

/** Minimal shields.io-style two-segment SVG badge: "specfirst" label + status text. */
export function renderBadgeSvg(input: BadgeInput): string {
  const text = badgeText(input);
  const color = TONE_COLOR[input.status];
  const labelWidth = Math.round(LABEL.length * CHAR_WIDTH + PADDING * 2);
  const textWidth = Math.round(text.length * CHAR_WIDTH + PADDING * 2);
  const totalWidth = labelWidth + textWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${HEIGHT}" role="img" aria-label="${LABEL}: ${text}">
  <title>${LABEL}: ${text}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".08"/>
    <stop offset="1" stop-opacity=".08"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="${HEIGHT}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="${HEIGHT}" fill="#2b2f38"/>
    <rect x="${labelWidth}" width="${textWidth}" height="${HEIGHT}" fill="${color}"/>
    <rect width="${totalWidth}" height="${HEIGHT}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${LABEL}</text>
    <text x="${labelWidth + textWidth / 2}" y="14">${text}</text>
  </g>
</svg>`;
}
