import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { keccak256, toHex } from 'viem';
import { canonicalJson } from '@specfirst/core';
import { ReportHashCheck } from '../components/ReportHashCheck';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const REPORT = { specfirst: 1, name: 'StakingVault', invariants: [], unverified: [] };
const CORRECT_HASH = keccak256(toHex(canonicalJson(REPORT)));

function mockFetchJson(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })),
  );
}

describe('ReportHashCheck', () => {
  it('shows a match when the recomputed hash equals the on-chain reportHash', async () => {
    mockFetchJson(REPORT);
    render(<ReportHashCheck reportUrl="https://example.test/report.json" onChainHash={CORRECT_HASH} />);
    await waitFor(() => expect(screen.getByText(/matches on-chain reportHash/i)).toBeInTheDocument());
  });

  it('shows a mismatch when the on-chain reportHash does not match the fetched report', async () => {
    mockFetchJson(REPORT);
    const wrongHash = '0x' + '11'.repeat(32);
    render(<ReportHashCheck reportUrl="https://example.test/report.json" onChainHash={wrongHash} />);
    await waitFor(() => expect(screen.getByText(/does NOT match on-chain reportHash/)).toBeInTheDocument());
  });

  it('reports an error state when there is no report URL', async () => {
    render(<ReportHashCheck reportUrl={null} onChainHash={CORRECT_HASH} />);
    await waitFor(() => expect(screen.getByText(/no report URL/)).toBeInTheDocument());
  });
});
