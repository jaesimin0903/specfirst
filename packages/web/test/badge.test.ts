import { describe, expect, it } from 'vitest';
import { badgeText, renderBadgeSvg } from '../lib/badge';

describe('badgeText', () => {
  it('formats a valid certificate as "certified, N invariants, time ago"', () => {
    const now = new Date('2026-10-10T00:00:00Z');
    const text = badgeText({ status: 'valid', passed: 7, total: 7, issuedAt: '2026-10-07T00:00:00Z', now });
    expect(text).toBe('certified, 7 invariants, 3 days ago');
  });

  it('flags a superseded certificate as still certified with a newer version note', () => {
    const text = badgeText({ status: 'superseded', passed: 7, total: 7, issuedAt: '2026-10-07T00:00:00Z' });
    expect(text).toBe('certified, 7 invariants, newer version available');
  });

  it('reports revoked with no counts', () => {
    expect(badgeText({ status: 'revoked', passed: 7, total: 7, issuedAt: null })).toBe('revoked');
  });
});

describe('renderBadgeSvg', () => {
  it('renders a stable SVG snapshot for a certified badge', () => {
    const svg = renderBadgeSvg({ status: 'valid', passed: 7, total: 7, issuedAt: '2026-10-07T00:00:00Z', now: new Date('2026-10-10T00:00:00Z') });
    expect(svg).toMatchSnapshot();
  });

  it('includes the status text in the accessible label', () => {
    const svg = renderBadgeSvg({ status: 'none', passed: 0, total: 0, issuedAt: null });
    expect(svg).toContain('no certificate');
    expect(svg).toContain('role="img"');
  });
});
