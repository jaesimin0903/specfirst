import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { assembleBoard, collectReports } from '../lib/board/pipeline';
import { toExplorerRow } from '../lib/board/view';
import type { BoardData, RegistryRead, VaultDetail } from '../lib/board/types';
import { VaultView } from '../components/board/VaultView';
import { BoardExplorer } from '../components/board/BoardExplorer';
import { Figures, Findings } from '../components/board/BoardSections';
import { buildVaultApi } from '../lib/desk/vaultApi';

/* The board on the fixture reports of test/fixtures/levels (see its README.txt), one per case. */

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'fixtures/levels');
const TY_YIELD = '0xb4641064f64e2f3aaffc1b4b4a66be75c1c81408';
const MUST_AND_RT = '0x9999999999999999999999999999999999999999';
const WITHDRAW_ACCESS = '0x1000000000000000000000000000000000000001';
const REDEEM_ALLOWANCE = '0x1000000000000000000000000000000000000002';
const WITHDRAW_SHARE = '0x1000000000000000000000000000000000000003';
const RT_LARGE = '0x1000000000000000000000000000000000000004';
const RT_UNKNOWN = '0x1000000000000000000000000000000000000005';
const RT_INJECTED = '0x1000000000000000000000000000000000000006';
const ZERO_ALLOWANCE = '0x1000000000000000000000000000000000000007';

let board: BoardData;
let details: VaultDetail[];

beforeAll(async () => {
  const { candidates, skipped } = await collectReports(SOURCE);
  expect(skipped).toEqual([]);
  const registry: RegistryRead = { chainId: 10143, address: '0x3754918bBB8481D046D80718a9efe434e353daF7', rpc: 'x', status: 'skipped', error: null, attestationCount: null, readAt: null };
  ({ board, details } = assembleBoard({ candidates, meta: {}, generatedAt: '2026-10-07T00:00:00.000Z', source: 'fixtures', skipped, registry, attestations: new Map() }));
});

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const detailOf = (address: string) => details.find((d) => d.row.id === `143/${address}`)!;
const head = () => screen.getByRole('banner');
const failedRegion = () => screen.getByRole('region', { name: 'What failed' });

describe('vault pages, one per case', () => {
  it('tyYIELD, round trips off by 1 base unit: "Rounding favors the caller", the size, SHOULD on each failure', () => {
    render(<VaultView detail={detailOf(TY_YIELD)} />);
    expect(within(head()).getByText('Rounding favors caller')).toBeInTheDocument();
    expect(
      within(head()).getByText(
        "Rounding favors the caller: 3 round-trip properties fail EIP-4626's SHOULD guidance (Security Considerations) at block 109,195,820, by at most 1 base unit, <0.01% of the amount; no MUST sentence failed.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/contradicts an EIP-4626 MUST sentence/)).toBeNull();
    expect(within(failedRegion()).getAllByText('EIP-4626 SHOULD')).toHaveLength(3);
    expect(within(failedRegion()).getAllByText(/the round trip ended 1 base unit in the caller's favor/)).toHaveLength(3);
    const table = screen.getByRole('region', { name: 'All 30 properties' });
    expect(within(table).getByText(/26 properties: 16 on EIP-4626 MUST sentences, 10 on SHOULD guidance/)).toBeInTheDocument();
  });

  it('a MUST next to a round trip: the spec mismatch sentence, each failure with its level', () => {
    render(<VaultView detail={detailOf(MUST_AND_RT)} />);
    expect(within(head()).getByText('Spec mismatch')).toBeInTheDocument();
    expect(within(head()).getByText("2 of 30 properties failed at block 109,195,820. The vault's behavior contradicts an EIP-4626 MUST sentence.")).toBeInTheDocument();
    expect(within(failedRegion()).getByText('EIP-4626 MUST')).toBeInTheDocument();
    expect(within(failedRegion()).getByText('EIP-4626 SHOULD')).toBeInTheDocument();
  });

  it('withdraw with reason "access control", as a reverting vault view leaves it: a MUST, with the note on where allowance shows', () => {
    render(<VaultView detail={detailOf(WITHDRAW_ACCESS)} />);
    expect(within(head()).getByText('Spec mismatch')).toBeInTheDocument();
    expect(within(head()).getByText("1 of 30 properties failed at block 109,195,820. The vault's behavior contradicts an EIP-4626 MUST sentence.")).toBeInTheDocument();
    expect(within(failedRegion()).getByText('EIP-4626 MUST')).toBeInTheDocument();
    expect(within(failedRegion()).getByText(/counts as a MUST whatever its reason says, since the reason text can come from the vault\. A vault that only skips the allowance check shows up in withdraw-zero-allowance and redeem-zero-allowance, which are SHOULDs/)).toBeInTheDocument();
    const row = document.getElementById('p-withdraw')!;
    expect(within(row).getByText('EIP-4626 MUST')).toBeInTheDocument();
    expect(within(row).getByText(/shows up in withdraw-zero-allowance and redeem-zero-allowance/)).toBeInTheDocument();
  });

  it('redeem with an "allowance" assertion reason is a MUST as well', () => {
    render(<VaultView detail={detailOf(REDEEM_ALLOWANCE)} />);
    expect(within(head()).getByText(/contradicts an EIP-4626 MUST sentence/)).toBeInTheDocument();
    expect(within(failedRegion()).getByText('EIP-4626 MUST')).toBeInTheDocument();
  });

  it('a vault that only skips the allowance check: withdraw-zero-allowance fails, a SHOULD', () => {
    render(<VaultView detail={detailOf(ZERO_ALLOWANCE)} />);
    expect(within(head()).getByText(/1 withdraw or redeem for an owner went through without the owner's allowance, which the vault SHOULD check\. No MUST sentence failed\./)).toBeInTheDocument();
    expect(within(failedRegion()).getByText('EIP-4626 SHOULD')).toBeInTheDocument();
  });

  it('a 1-unit pair the vault wrote with console.log does not make a 4,000,000 round trip rounding', () => {
    render(<VaultView detail={detailOf(RT_INJECTED)} />);
    expect(within(head()).getByText('Spec mismatch')).toBeInTheDocument();
    expect(within(head()).getByText(/a round trip favors the caller by 4,000,000 base units, 80% of the amount, more than rounding/)).toBeInTheDocument();
    expect(within(failedRegion()).getByText(/the round trip ended 4,000,000 base units in the caller's favor \(5,000,000 against 1,000,000\)/)).toBeInTheDocument();
  });

  it('withdraw failing its "share" assertion stays a MUST', () => {
    render(<VaultView detail={detailOf(WITHDRAW_SHARE)} />);
    expect(within(head()).getByText("1 of 30 properties failed at block 109,195,820. The vault's behavior contradicts an EIP-4626 MUST sentence.")).toBeInTheDocument();
    expect(within(failedRegion()).getByText('EIP-4626 MUST')).toBeInTheDocument();
    expect(within(document.getElementById('p-withdraw')!).getByText('EIP-4626 MUST')).toBeInTheDocument();
  });

  it('a round trip off by 5%: the mismatch chip and "favors the caller by" the size, more than rounding', () => {
    render(<VaultView detail={detailOf(RT_LARGE)} />);
    expect(within(head()).getByText('Spec mismatch')).toBeInTheDocument();
    expect(within(head()).getByText(/a round trip favors the caller by 50,000 base units, 4\.76% of the amount, more than rounding\. No MUST sentence failed\./)).toBeInTheDocument();
    expect(within(failedRegion()).getByText(/a difference of 50,000 base units, 4\.76% of the amount, is more than rounding/)).toBeInTheDocument();
  });

  it('a round trip whose size the report does not give: the mismatch chip, not rounding', () => {
    render(<VaultView detail={detailOf(RT_UNKNOWN)} />);
    expect(within(head()).getByText('Spec mismatch')).toBeInTheDocument();
    expect(within(head()).getByText(/a round trip favors the caller by an amount the report does not give/)).toBeInTheDocument();
  });
});

describe('the board and the API', () => {
  it('the table shows the rounding chip only for tyYIELD and counts it inside the mismatches; the status filter is unchanged', () => {
    render(<BoardExplorer rows={board.vaults.map(toExplorerRow)} protocols={[]} split={26} />);
    const rows = screen.getAllByRole('row');
    expect(rows.filter((r) => within(r).queryByText('Rounding favors caller'))).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Spec mismatch/ })).toHaveTextContent('Spec mismatch 9 (1 only rounding)');
  });

  it('the figures and the findings count and label the same way', () => {
    render(
      <>
        <Figures board={board} />
        <Findings board={board} />
      </>,
    );
    expect(screen.getByText(/1 of them only round trips, a SHOULD/)).toBeInTheDocument();
    const findings = screen.getByRole('region', { name: 'Where vaults disagree with EIP-4626' });
    // SHOULD: 3 + 1 round trips (tyYIELD, MUST_AND_RT), the large, unknown and injected round trips, withdraw-zero-allowance.
    // MUST: previewDeposit and the three withdraw or redeem failures.
    expect(within(findings).getAllByText('EIP-4626 SHOULD')).toHaveLength(8);
    expect(within(findings).getAllByText('EIP-4626 MUST')).toHaveLength(4);
  });

  it('the vault API keeps badge.state and adds the levels', () => {
    const live = { kind: 'none' as const };
    const api = buildVaultApi({ resolved: { chainId: 143, address: WITHDRAW_ACCESS, detail: detailOf(WITHDRAW_ACCESS), source: 'board' } as never, live, origin: 'https://x' });
    expect(api.report?.failed).toEqual([expect.objectContaining({ id: 'withdraw', level: 'must' })]);
    expect(api.badge).toMatchObject({ state: 'not-attested', level: null });
    const must = buildVaultApi({ resolved: { chainId: 143, address: WITHDRAW_SHARE, detail: detailOf(WITHDRAW_SHARE), source: 'board' } as never, live, origin: 'https://x' });
    expect(must.report?.failed).toEqual([expect.objectContaining({ id: 'withdraw', level: 'must' })]);
  });
});
