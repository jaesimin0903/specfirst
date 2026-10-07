import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { computeProgress } from '../lib/desk/stages';
import type { DeskViewJson, RequestViewJson, ResultJson } from '../lib/desk/types';
import { Timeline } from '../components/desk/Timeline';
import { ResultCard } from '../components/desk/ResultCard';
import { PrecheckCard } from '../components/desk/PrecheckCard';
import type { PrecheckResult } from '../lib/desk/precheck';
import { DeskView } from '../components/desk/DeskView';
import { RecentRequests } from '../components/desk/RecentRequests';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => '/check' }));

import { RequestProgress } from '../components/desk/RequestProgress';
import { CheckFlow } from '../components/desk/CheckFlow';

const UPSHIFT = '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E';
const T0 = Math.floor(Date.now() / 1000) - 120;
const FEE = '100000000000000000';
const TX = `0x${'c0'.repeat(32)}`;

const result: ResultJson = {
  vaultPath: `/v/143/${UPSHIFT.toLowerCase()}`,
  status: 'mismatch',
  summary: { pass: 16, fail: 2, inconclusive: 12, notApplicable: 0 },
  total: 30,
  cells: 'pppppppppiiiiiiiiiiiippppppppff'.slice(0, 30),
  split: 26,
  failed: [{ id: 'sf-maxWithdraw-honored', finding: 'maxWithdraw was 3, but withdraw(1) reverted with 0x75ed2e3e, WithdrawalRequestRequired().', rule: 'EIP-4626: maxWithdraw MUST ...' }],
  blockNumber: '109400000',
  startedAt: '2026-10-01T00:00:00.000Z',
  reportHash: `0x${'ab'.repeat(32)}`,
  reportPath: `/api/v1/reports/143/${UPSHIFT.toLowerCase()}/109400000.json`,
  attestation: { id: '18', status: 'Valid', isCompliant: false, matchesReport: true, txHash: `0x${'a1'.repeat(32)}` },
  badgePath: `/badge/check/143/${UPSHIFT.toLowerCase()}.svg`,
  apiPath: `/api/v1/vaults/143/${UPSHIFT.toLowerCase()}`,
  reproduce: `specfirst check ${UPSHIFT} --standard erc4626 --block 109400000 --runs 16`,
};

function view(status: 'Pending' | 'Fulfilled', stage: 'running' | 'fulfilled' | null, over: Partial<RequestViewJson> = {}): RequestViewJson {
  const worker = stage ? { stage, updatedAt: new Date((T0 + 60) * 1000).toISOString(), txs: stage === 'fulfilled' ? { attest: `0x${'a1'.repeat(32)}` } : {} } : null;
  return {
    desk: { address: '0x00000000000000000000000000000000000D35c0', chainId: 10143, subjectChainId: 143, standardId: '0x45f3' },
    request: { id: '4', requester: '0x1111111111111111111111111111111111111111', subjectChainId: 143, subject: UPSHIFT, standardId: '0x45f3', feeWei: FEE, requestedAt: new Date(T0 * 1000).toISOString(), status, attestationId: status === 'Fulfilled' ? '18' : '0', rejectReason: `0x${'0'.repeat(64)}` },
    vault: { name: 'earnAUSD', protocol: 'Upshift', assetSymbol: 'AUSD' },
    worker: { available: true, problem: null, stage, updatedAt: worker?.updatedAt ?? null, error: null, txs: worker?.txs ?? {}, gasCostWei: null },
    timeoutSec: '3600',
    progress: computeProgress({ status, requestedAt: BigInt(T0), timeoutSec: 3600n, worker: worker as never, nowSec: T0 + 120 }),
    result: status === 'Fulfilled' ? result : null,
    readAt: new Date().toISOString(),
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Timeline', () => {
  it('names each step and its state, with tx links for the onchain ones', () => {
    render(<Timeline progress={view('Pending', 'running').progress} txs={{ request: TX }} />);
    const list = screen.getByRole('list', { name: 'Request progress' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-s'))).toEqual(['done', 'done', 'done', 'active', 'waiting', 'waiting']);
    expect(items[3]).toHaveAttribute('aria-current', 'step');
    expect(within(items[3]!).getByText('Running 30 properties')).toBeInTheDocument();
    expect(within(items[0]!).getByRole('link')).toHaveAttribute('href', `https://testnet.monadscan.com/tx/${TX}`);
  });
});

describe('RequestProgress', () => {
  it('in progress: paid, where it is, what is coming, and the escrow rule, on one screen', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<RequestProgress id="4" initial={{ kind: 'ok', view: view('Pending', 'running') }} rpc="http://127.0.0.1:9" faucet="https://faucet.test" txParam={TX} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('earnAUSD');
    const paid = screen.getByRole('region', { name: 'You paid' });
    expect(within(paid).getByText('0.1')).toBeInTheDocument();
    expect(within(paid).getByText('In escrow')).toBeInTheDocument();
    expect(within(paid).getByRole('link', { name: /tx 0xc0c0c0/ })).toHaveAttribute('href', `https://testnet.monadscan.com/tx/${TX}`);
    const now = screen.getByRole('region', { name: 'Where it is' });
    expect(within(now).getByText('Running 30 properties')).toBeInTheDocument();
    expect(within(now).getByRole('img', { name: '30 properties, no results yet' })).toBeInTheDocument();
    const get = screen.getByRole('region', { name: 'You get' });
    expect(within(get).queryAllByRole('link')).toHaveLength(0);
    expect(screen.getByText(/becomes the desk's only when the worker fulfils this request/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Refund/ })).not.toBeInTheDocument();
  });

  it('fulfilled: the result card with the attestation, badge and API', () => {
    render(<RequestProgress id="4" initial={{ kind: 'ok', view: view('Fulfilled', 'fulfilled') }} rpc="http://127.0.0.1:9" faucet="https://faucet.test" txParam={null} />);
    expect(within(screen.getByRole('region', { name: 'You paid' })).getByText('Earned by the desk')).toBeInTheDocument();
    const get = screen.getByRole('region', { name: 'You get' });
    expect(within(get).getByRole('link', { name: '30 property results' })).toHaveAttribute('href', result.vaultPath);
    expect(within(get).getByRole('link', { name: 'Attestation #18' })).toBeInTheDocument();
    const card = screen.getByRole('article', { name: 'The result' });
    expect(within(card).getByText(/2 of 30 properties failed at block 109,400,000/)).toBeInTheDocument();
    expect(within(card).getByText('sf-maxWithdraw-honored')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: /Specfirst ERC-4626 check badge/ })).toHaveAttribute('src', result.badgePath);
    expect(within(card).getByText((t) => t.startsWith('[![Specfirst ERC-4626 check]'))).toBeInTheDocument();
    expect(within(card).getByText(/curl -s .*\/api\/v1\/vaults\/143\//)).toBeInTheDocument();
  });

  it('expired: offers the refund, explains who gets the money', () => {
    const v = view('Pending', 'running');
    v.progress = computeProgress({ status: 'Pending', requestedAt: BigInt(T0), timeoutSec: 60n, worker: null, nowSec: T0 + 120 });
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    render(<RequestProgress id="4" initial={{ kind: 'ok', view: v }} rpc="http://127.0.0.1:9" faucet="https://faucet.test" txParam={null} />);
    expect(screen.getByText('Expired', { selector: '.sb-now' })).toBeInTheDocument();
    expect(screen.getByText(/the fee goes to the requester, not to whoever sends it/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refund 0.1 MON' })).toBeDisabled();
  });

  it('desk not deployed', () => {
    render(<RequestProgress id="4" initial={{ kind: 'not-deployed' }} rpc="x" faucet="x" txParam={null} />);
    expect(screen.getByRole('heading', { name: 'Desk not deployed' })).toBeInTheDocument();
  });
});

describe('ResultCard', () => {
  it('uses the given origin in the embed code', () => {
    render(<ResultCard result={result} origin="https://specfirst.test" />);
    expect(screen.getByText(`[![Specfirst ERC-4626 check](https://specfirst.test${result.badgePath})](https://specfirst.test${result.vaultPath})`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Attest tx/ })).toHaveAttribute('href', `https://testnet.monadscan.com/tx/0x${'a1'.repeat(32)}`);
  });

  it('a MUST failure keeps the spec mismatch chip and sentence', () => {
    render(<ResultCard result={result} origin="https://specfirst.test" />);
    expect(screen.getByText('Spec mismatch')).toBeInTheDocument();
    expect(screen.getByText(/contradicts an EIP-4626 MUST sentence/)).toBeInTheDocument();
  });

  it('round trips off by a rounding difference read as the board reads them: the rounding chip and verdict', () => {
    const rt = (id: string) => ({ id, finding: "Forge found a counterexample: the round trip ended 1 base unit in the caller's favor.", rule: null, topic: 'rounding' as const, delta: '1', amount: '1000001' });
    const rounding: ResultJson = { ...result, summary: { pass: 27, fail: 3, inconclusive: 0, notApplicable: 0 }, failed: [rt('RT-redeem-deposit'), rt('RT-redeem-mint'), rt('RT-withdraw-deposit')] };
    render(<ResultCard result={rounding} origin="https://specfirst.test" />);
    expect(screen.getByText('Rounding favors caller')).toBeInTheDocument();
    expect(screen.queryByText('Spec mismatch')).toBeNull();
    expect(
      screen.getByText(
        "Rounding favors the caller: 3 round-trip properties fail EIP-4626's SHOULD guidance (Security Considerations) at block 109,400,000, by at most 1 base unit, <0.01% of the amount; no MUST sentence failed.",
      ),
    ).toBeInTheDocument();
  });
});

describe('PrecheckCard', () => {
  it('a vault whose only failures are rounding-sized round trips: the rounding label and mark, as on the board', () => {
    const p: PrecheckResult = {
      input: UPSHIFT,
      chainId: 143,
      address: UPSHIFT,
      ok: true,
      contract: null,
      onBoard: true,
      latestReport: { status: 'mismatch', summary: { pass: 27, fail: 3, inconclusive: 0, notApplicable: 0 }, blockNumber: '109195820', startedAt: '', source: 'board', failureLevel: 'rounding' },
      attestation: null,
      pending: [],
      blockers: [],
      notes: [],
    };
    const { container, rerender } = render(<PrecheckCard p={p} />);
    expect(screen.getByRole('link', { name: 'Rounding favors caller' })).toHaveAttribute('href', `/v/143/${UPSHIFT.toLowerCase()}`);
    expect(container.querySelector('.sb-glyph rect.s')).not.toBeNull();
    rerender(<PrecheckCard p={{ ...p, latestReport: { ...p.latestReport!, failureLevel: 'must' } }} />);
    expect(screen.getByRole('link', { name: 'Spec mismatch' })).toBeInTheDocument();
    expect(container.querySelector('.sb-glyph rect.f')).not.toBeNull();
  });
});

describe('CheckFlow', () => {
  it('without a desk: look-ups work, paying is closed and says why', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.startsWith('/api/desk')
            ? { deployed: false, address: null, chainId: 10143, feeWei: null, timeoutSec: null, requestCount: null, earnedWei: null, withdrawnWei: null, escrowedWei: null, owner: null, worker: null, registry: null, errors: [], readAt: '' }
            : {},
      })),
    );
    render(<CheckFlow deskAddress={null} rpc="http://127.0.0.1:9" faucet="https://faucet.test" initialVault="" exampleVault="/v/143/0xabc" />);
    const pay = screen.getByRole('button', { name: 'Pay and request the check' });
    expect(pay).toBeDisabled();
    await waitFor(() => expect(screen.getByText(/desk is not deployed on Monad testnet yet/)).toBeInTheDocument());
    const receipt = screen.getByRole('complementary', { name: 'What you pay and what you get' });
    expect(within(receipt).getByText('not open')).toBeInTheDocument();
    expect(within(receipt).getByText(/becomes ours only when your attestation lands onchain/)).toBeInTheDocument();
    expect(within(receipt).getByRole('link', { name: 'see one' })).toHaveAttribute('href', '/v/143/0xabc');
    expect(screen.getByRole('button', { name: 'Testnet burner' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('with a desk and a vault: shows the fee on the pay button and the pre-check result', async () => {
    const precheck = {
      input: UPSHIFT,
      chainId: 143,
      address: UPSHIFT,
      ok: true,
      contract: { isContract: true, name: 'earnAUSD', symbol: 'earnAUSD', decimals: 6, asset: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a', assetSymbol: 'AUSD', assetDecimals: 6, totalAssets: '1000000000', protocol: 'Upshift' },
      onBoard: true,
      latestReport: { status: 'mismatch', summary: { pass: 16, fail: 2, inconclusive: 12, notApplicable: 0 }, blockNumber: '109195820', startedAt: '', source: 'board' },
      attestation: { kind: 'none' },
      pending: [],
      blockers: [],
      notes: ['Checked before at block 109,195,820 for the board. A new request checks the vault again at the latest block and attests the new report.'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.startsWith('/api/desk')
            ? { deployed: true, address: '0x00000000000000000000000000000000000D35c0', chainId: 10143, feeWei: FEE, timeoutSec: '3600', requestCount: '0', earnedWei: '0', withdrawnWei: '0', escrowedWei: '0', owner: null, worker: null, registry: null, errors: [], readAt: '' }
            : precheck,
      })),
    );
    render(<CheckFlow deskAddress="0x00000000000000000000000000000000000D35c0" rpc="http://127.0.0.1:9" faucet="https://faucet.test" initialVault={UPSHIFT} exampleVault={null} />);
    await waitFor(() => expect(screen.getByText('earnAUSD')).toBeInTheDocument());
    expect(screen.getByText('1,000 AUSD held')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Spec mismatch' })).toHaveAttribute('href', `/v/143/${UPSHIFT.toLowerCase()}`);
    expect(screen.getByRole('button', { name: 'Pay 0.1 MON and request the check' })).toBeDisabled();
    expect(screen.getByText('Connect a wallet first.')).toBeInTheDocument();
    expect(screen.getByText(/If nothing is fulfilled within 1 h, anyone can refund it to you/)).toBeInTheDocument();
  });
});

describe('DeskView and the board band', () => {
  const data: DeskViewJson = {
    summary: { deployed: true, address: '0x00000000000000000000000000000000000D35c0', chainId: 10143, feeWei: FEE, timeoutSec: '3600', requestCount: '3', earnedWei: FEE, withdrawnWei: '0', escrowedWei: FEE, owner: null, worker: null, registry: null, errors: [], readAt: '2026-10-01T00:00:00.000Z' },
    economics: {
      feeWei: FEE,
      earnedWei: FEE,
      withdrawnWei: '0',
      escrowedWei: FEE,
      withdrawableWei: FEE,
      gasCostWei: '4000000000000000',
      netWei: '96000000000000000',
      marginPct: 96,
      gasPerCheckWei: '2000000000000000',
      unitProfitWei: '98000000000000000',
      counts: { total: 3, pending: 1, fulfilled: 1, rejected: 1, refunded: 0, expired: 0, paidWei: '300000000000000000', returnedWei: FEE, truncated: false },
      summary: 'Of 3 paid checks, 1 was fulfilled.',
    },
    recent: [],
    worker: { available: true, problem: null, fulfilled: 1, rejected: 1 },
  };

  it('/desk shows the figures and where each paid fee is', () => {
    render(<DeskView data={data} />);
    expect(screen.getByText('Fee per check').closest('.sb-figure')).toHaveTextContent('0.1MON');
    expect(screen.getByText('Net').closest('.sb-figure')).toHaveTextContent('0.096MON');
    expect(screen.getByText('Net').closest('.sb-figure')).toHaveTextContent('earned minus gas, 96% of earned');
    expect(screen.getByRole('img', { name: 'Earned 33.33%, in escrow 33.33%, returned 33.33%' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Make the first one' })).toHaveAttribute('href', '/check');
  });

  it('/desk without a desk says how to configure it', () => {
    render(<DeskView data={{ ...data, summary: { ...data.summary, deployed: false, address: null } }} />);
    expect(screen.getByRole('heading', { name: 'Desk not deployed' })).toBeInTheDocument();
  });

  it('Recently requested lists requests and links finished ones to the vault page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          deployed: true,
          requests: [
            { request: { ...view('Fulfilled', 'fulfilled').request, id: '4' }, vault: { name: 'earnAUSD', protocol: 'Upshift', assetSymbol: 'AUSD' }, stage: 'fulfilled', label: 'Fulfilled', tone: 'done' },
            { request: { ...view('Pending', 'running').request, id: '5' }, vault: { name: null, protocol: null, assetSymbol: null }, stage: 'running', label: 'Running', tone: 'active' },
          ],
        }),
      })),
    );
    render(<RecentRequests />);
    await waitFor(() => expect(screen.getByRole('link', { name: 'earnAUSD' })).toHaveAttribute('href', `/v/143/${UPSHIFT.toLowerCase()}`));
    expect(screen.getByRole('link', { name: '0xD793...dA5E' })).toHaveAttribute('href', '/check/5');
    expect(screen.getByRole('link', { name: 'Request a check' })).toHaveAttribute('href', '/check');
  });
});
