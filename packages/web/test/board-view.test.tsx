import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { assembleBoard, collectReports, readVaultMeta } from '../lib/board/pipeline';
import { attestationViewOf, toRecord, type RawAttestation } from '../lib/board/attestations';
import { loadBoard, loadVaultDetail } from '../lib/board/load';
import { filterRows, filtersFromSearch, searchFromFilters, sortRows, toExplorerRow } from '../lib/board/view';
import type { BoardData, RegistryRead, VaultDetail } from '../lib/board/types';
import { VaultView, reproduceCommand, reproduceCommandMultiline } from '../components/board/VaultView';
import { BoardExplorer } from '../components/board/BoardExplorer';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'fixtures/board/checks');
const META = path.join(here, 'fixtures/board/vault-meta.json');
const UPSHIFT = '0xd793c04b87386a6bb84ee61d98e0065fde7fda5e';
const STEAKHOUSE = '0x802c91d807a8daca257c4708ab264b6520964e44';
const RESTRICTED = '0xea4be2705517b0ee0bbabd5e73cea3dc509d3c36';
const REG = { chainId: 10143, address: '0x3754918bBB8481D046D80718a9efe434e353daF7', rpc: 'https://testnet-rpc.monad.xyz' };

let unread: { board: BoardData; details: VaultDetail[] };
let attested: { board: BoardData; details: VaultDetail[] };

beforeAll(async () => {
  const { candidates, skipped } = await collectReports(SOURCE);
  const meta = await readVaultMeta(META);
  const common = { candidates, meta, generatedAt: '2026-10-01T00:00:00.000Z', source: 'fixtures', skipped };
  const err: RegistryRead = { ...REG, status: 'error', error: 'HTTP request failed.', attestationCount: null, readAt: '2026-10-01T00:00:00.000Z' };
  unread = assembleBoard({ ...common, registry: err, attestations: new Map() });
  const steak = candidates.find((c) => c.report.address.toLowerCase() === STEAKHOUSE)!;
  const raw: RawAttestation = {
    subjectChainId: 143n,
    subject: steak.report.address,
    standardId: '0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab',
    blockNumber: 109061472n,
    implementationKey: steak.report.identity.implementationKey,
    subjectCodeHash: steak.report.identity.codeHash,
    suiteHash: steak.suiteHash,
    reportHash: `0x${'ab'.repeat(32)}`,
    passCount: 30,
    failCount: 0,
    inconclusiveCount: 0,
    notApplicableCount: 0,
    issuedAt: 1790755171n,
    issuer: '0x1d93fFd65BD3C522766f1f5301660eec559D4D39',
    status: 1,
    reportURI: 'https://raw.githubusercontent.com/jaesimin/specfirst/main/certs/checks/143/x.json',
  };
  const ok: RegistryRead = { ...REG, status: 'ok', error: null, attestationCount: 1, readAt: '2026-10-01T00:00:00.000Z' };
  const rec = toRecord(0n, raw, true, { '0': '0x7a4c1d630a9a50cc6ef107db21e71a01d2c2789379b5f7db2f2bfb840c2e87d9' });
  attested = assembleBoard({ ...common, registry: ok, attestations: new Map([[`143/${STEAKHOUSE}`, rec]]) });
  expect(attestationViewOf(ok, rec, steak).kind).toBe('attested');
});

afterEach(() => {
  cleanup();
  // The table keeps its filters in the query string; each test starts from a clean URL.
  window.history.replaceState(null, '', '/');
});

const detailOf = (set: { details: VaultDetail[] }, address: string) => set.details.find((d) => d.row.id === `143/${address}`)!;

describe('vault page', () => {
  it('a mismatch: verdict, what failed in words, all 30 properties, replay command', () => {
    const d = detailOf(unread, UPSHIFT);
    render(<VaultView detail={d} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('earnAUSD');
    expect(screen.getByText(/2 of 30 properties failed at block 109,195,820/)).toBeInTheDocument();
    const failed = screen.getByRole('region', { name: 'What failed' });
    expect(within(failed).getByText('maxWithdraw was 3, but withdraw(1) reverted with 0x75ed2e3e, WithdrawalRequestRequired().')).toBeInTheDocument();
    expect(within(failed).getByText(/not a claim that funds are at risk/)).toBeInTheDocument();
    const table = screen.getByRole('region', { name: 'All 30 properties' });
    expect(within(table).getAllByRole('row').filter((r) => r.id.startsWith('p-'))).toHaveLength(30);
    expect(within(table).getAllByText('Fail')).toHaveLength(2);
    expect(within(table).getAllByText(/^Never exercised: the vault rejected nearly every amount/).length).toBeGreaterThan(0);
    expect(reproduceCommand(d.report)).toBe(`specfirst check ${d.report.address} --standard erc4626 --block 109195820 --runs 16 --seed ${d.report.seed}`);
    expect(screen.getByText((_, el) => el?.tagName === 'PRE' && el.textContent === reproduceCommandMultiline(d.report))).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Report JSON' })).toHaveAttribute('href', `/reports/143/${UPSHIFT}/109195820.json`);
  });

  it('an asynchronous vault: the trait label sits next to the verdict, the ERC-7540 sentence joins both max failures, nothing else changes', () => {
    const d = detailOf(unread, UPSHIFT);
    // A schemaVersion 4 report of the same check would carry this; the fixture predates traits.
    expect(d.row.traits).toEqual([]);
    const trait = {
      id: 'async-redeem' as const,
      evidence: { codeAddress: '0xFd2F793C248Dd673C830DF610a95a045054de267', requestFunctions: ['requestRedeem(uint256,address,address)'], erc165: null, run: 'exits-rejected' as const },
    };
    render(<VaultView detail={{ ...d, row: { ...d.row, traits: [trait] }, report: { ...d.report, traits: [trait] } }} />);
    expect(screen.getByText(/2 of 30 properties failed at block 109,195,820/)).toBeInTheDocument();
    expect(screen.getByText('Asynchronous withdrawals: exits go through requestRedeem')).toBeInTheDocument();
    const failed = screen.getByRole('region', { name: 'What failed' });
    expect(within(failed).getAllByText('For an asynchronous vault, ERC-7540 still requires maxWithdraw and maxRedeem to report what can be claimed now.')).toHaveLength(2);
    const table = screen.getByRole('region', { name: 'All 30 properties' });
    expect(within(table).getAllByText('Fail')).toHaveLength(2);
    expect(within(table).getAllByText(/^For an asynchronous vault, ERC-7540 still requires/)).toHaveLength(2);
  });

  it('shows "could not read attestation status" when the registry read failed', () => {
    render(<VaultView detail={detailOf(unread, UPSHIFT)} />);
    const panel = screen.getByRole('region', { name: 'Onchain attestation' });
    expect(within(panel).getByText('Could not read attestation status.')).toBeInTheDocument();
    expect(within(panel).getByText(/HTTP request failed\./)).toBeInTheDocument();
  });

  it('an attestation of an earlier report links its transaction and says it is a different report', () => {
    render(<VaultView detail={detailOf(attested, STEAKHOUSE)} />);
    const panel = screen.getByRole('region', { name: 'Onchain attestation' });
    expect(within(panel).getByText('Attestation #0')).toBeInTheDocument();
    expect(within(panel).getByText(/It records a different report, for block 109,061,472\. This page shows block 109,195,820\./)).toBeInTheDocument();
    expect(within(panel).getByText(/isCompliant is true/)).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: '0x7a4c1d...2e87d9' })).toHaveAttribute(
      'href',
      'https://testnet.monadscan.com/tx/0x7a4c1d630a9a50cc6ef107db21e71a01d2c2789379b5f7db2f2bfb840c2e87d9',
    );
  });

  it('a vault where nothing applies explains the skipReason first', () => {
    render(<VaultView detail={detailOf(unread, RESTRICTED)} />);
    expect(screen.getByText(/^No property applies\. The asset only moves between allowed parties/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'What failed' })).toBeNull();
  });
});

describe('vault table', () => {
  const setup = () => {
    const rows = unread.board.vaults.map(toExplorerRow);
    render(<BoardExplorer rows={rows} protocols={unread.board.protocols.map((p) => p.protocol).sort()} split={26} />);
    return rows;
  };

  it('a row with the async-redeem trait carries its label', () => {
    cleanup();
    const trait = {
      id: 'async-redeem' as const,
      evidence: { codeAddress: '0xFd2F793C248Dd673C830DF610a95a045054de267', requestFunctions: ['requestRedeem(uint256,address,address)'], erc165: null, run: 'exits-rejected' as const },
    };
    const withTrait = unread.board.vaults.map((v) => (v.id === `143/${UPSHIFT}` ? { ...v, traits: [trait] } : v)).map(toExplorerRow);
    expect(withTrait.find((r) => r.id === `143/${UPSHIFT}`)!.traits).toEqual([trait]);
    expect(withTrait.filter((r) => r.traits).length).toBe(1);
    render(<BoardExplorer rows={withTrait} protocols={unread.board.protocols.map((p) => p.protocol).sort()} split={26} />);
    expect(screen.getAllByText('Asynchronous withdrawals: exits go through requestRedeem')).toHaveLength(1);
  });

  it('lists every vault, mismatches first, with status in words', () => {
    setup();
    expect(screen.getByText('Showing 7 of 7 vaults')).toBeInTheDocument();
    const body = screen.getAllByRole('rowgroup')[1]!;
    const first = within(body).getAllByRole('row')[0]!;
    expect(within(first).getByText('Spec mismatch')).toBeInTheDocument();
    expect(within(body).getAllByText('Status not read')).toHaveLength(7);
  });

  it('filters by status, protocol and text, and folds into implementations', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: /Spec mismatch/ }));
    expect(screen.getByText('Showing 2 of 7 vaults')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'Euler EVK (eVault)' } });
    expect(screen.getByText('Showing 2 of 7 vaults')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Protocol'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'steakhouse' } });
    expect(screen.getByText('Showing 1 of 7 vaults')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Implementations' }));
    expect(screen.getByText('5 implementations for 7 of 7 vaults')).toBeInTheDocument();
    const toggle = screen.getAllByRole('button', { expanded: false })[0]!;
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens with the filters in the URL', () => {
    window.history.replaceState(null, '', '/?status=not_applicable');
    setup();
    expect(screen.getByText('Showing 2 of 7 vaults')).toBeInTheDocument();
  });

  it('sorts by a column and says so to assistive tech', () => {
    setup();
    const failHeader = screen.getByRole('button', { name: /^Fail/ });
    fireEvent.click(failHeader);
    expect(failHeader.closest('th')).toHaveAttribute('aria-sort', 'descending');
  });

  it('filter helpers round-trip through the query string', () => {
    const rows = unread.board.vaults.map(toExplorerRow);
    const f = filtersFromSearch('?status=mismatch&protocol=Upshift&q=ausd', ['Upshift']);
    expect(f).toEqual({ status: 'mismatch', protocol: 'Upshift', query: 'ausd' });
    expect(searchFromFilters(f)).toBe('?status=mismatch&protocol=Upshift&q=ausd');
    expect(filtersFromSearch('?status=bogus&protocol=Nope', ['Upshift'])).toEqual({ status: 'all', protocol: 'all', query: '' });
    expect(filterRows(rows, f).map((r) => r.id)).toEqual([`143/${UPSHIFT}`]);
    expect(filterRows(rows, { status: 'all', protocol: 'all', query: 'sf-maxDeposit-honored' })).toHaveLength(0);
    expect(filterRows(rows, { status: 'all', protocol: 'all', query: 'sf-maxRedeem-honored' })).toHaveLength(2);
    const byPass = sortRows(rows, 'pass', 'desc');
    expect(byPass[0]!.summary.pass).toBe(30);
  });
});

describe('loader', () => {
  it('renders an empty board when data/board.json is missing or broken', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sf-load-'));
    expect(loadBoard(dir).vaults).toEqual([]);
    await writeFile(path.join(dir, 'board.json'), '{"version":2}');
    expect(loadBoard(dir).source).toBe('none');
  });

  it('reads a board.json written before traits existed: rows get no traits and still render as explorer rows', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sf-load-'));
    const older = { ...unread.board, vaults: unread.board.vaults.map(({ traits: _traits, ...v }) => v) };
    await writeFile(path.join(dir, 'board.json'), JSON.stringify(older));
    const loaded = loadBoard(dir);
    expect(loaded.vaults.length).toBe(unread.board.vaults.length);
    expect(loaded.vaults.every((v) => Array.isArray(v.traits) && v.traits.length === 0)).toBe(true);
    expect(() => loaded.vaults.map(toExplorerRow)).not.toThrow();
  });

  it('reads a vault detail and refuses paths that are not a chain id and an address', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'sf-load-'));
    await mkdir(path.join(dir, 'vaults/143'), { recursive: true });
    const d = detailOf(unread, UPSHIFT);
    await writeFile(path.join(dir, 'vaults/143', `${UPSHIFT}.json`), JSON.stringify(d));
    expect(loadVaultDetail('143', UPSHIFT.toUpperCase().replace('0X', '0x'), dir)?.row.id).toBe(`143/${UPSHIFT}`);
    expect(loadVaultDetail('143', '../../etc/passwd', dir)).toBeNull();
    expect(loadVaultDetail('..', UPSHIFT, dir)).toBeNull();
    expect(loadVaultDetail('143', '0x0000000000000000000000000000000000000001', dir)).toBeNull();
  });
});
