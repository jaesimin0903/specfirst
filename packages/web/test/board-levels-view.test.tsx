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

/*
 * The board on two fixture reports (test/fixtures/levels): tyYIELD fails only three round trips, a SHOULD; the other
 * vault fails previewDeposit, a MUST, next to a round trip.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'fixtures/levels');
const TY_YIELD = '0xb4641064f64e2f3aaffc1b4b4a66be75c1c81408';
const MUST = '0x9999999999999999999999999999999999999999';

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

describe('a vault that fails only round trips', () => {
  it('reads "Rounding favors the caller", not a MUST mismatch, and names each level', () => {
    const d = detailOf(TY_YIELD);
    expect(d.row.status).toBe('mismatch');
    render(<VaultView detail={d} />);
    const head = screen.getByRole('banner');
    expect(within(head).getByText('Rounding favors caller')).toBeInTheDocument();
    expect(
      within(head).getByText(
        "Rounding favors the caller: 3 round-trip properties fail EIP-4626's SHOULD guidance (Security Considerations) at block 109,195,820; no MUST sentence failed.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/contradicts an EIP-4626 MUST sentence/)).toBeNull();
    const failed = screen.getByRole('region', { name: 'What failed' });
    expect(within(failed).getAllByText('EIP-4626 SHOULD')).toHaveLength(3);
    expect(within(failed).getAllByText(/rounding should favor the Vault over its users/)).toHaveLength(3);
    expect(within(failed).getByText(/That guidance is a SHOULD; no MUST sentence failed/)).toBeInTheDocument();
    const table = screen.getByRole('region', { name: 'All 30 properties' });
    expect(within(table).getByText(/26 properties: 16 on EIP-4626 MUST sentences, 10 on SHOULD guidance/)).toBeInTheDocument();
    expect(within(table).getAllByText('EIP-4626 SHOULD')).toHaveLength(10);
    expect(within(table).getAllByText('EIP-4626 MUST')).toHaveLength(20);
  });
});

describe('a vault with a MUST failure next to a round trip', () => {
  it('keeps the spec mismatch verdict and still names the round trip a SHOULD', () => {
    render(<VaultView detail={detailOf(MUST)} />);
    const head = screen.getByRole('banner');
    expect(within(head).getByText('Spec mismatch')).toBeInTheDocument();
    expect(within(head).getByText("2 of 30 properties failed at block 109,195,820. The vault's behavior contradicts an EIP-4626 MUST sentence.")).toBeInTheDocument();
    const failed = screen.getByRole('region', { name: 'What failed' });
    expect(within(failed).getByText('EIP-4626 MUST')).toBeInTheDocument();
    expect(within(failed).getByText('EIP-4626 SHOULD')).toBeInTheDocument();
    expect(within(failed).getByText(/A spec mismatch is a disagreement with an EIP-4626 MUST sentence, shown by a concrete call\. Properties marked SHOULD/)).toBeInTheDocument();
  });
});

describe('the board', () => {
  it('the table shows the rounding chip and counts it inside the mismatches; the status filter is unchanged', () => {
    render(<BoardExplorer rows={board.vaults.map(toExplorerRow)} protocols={[]} split={26} />);
    const rows = screen.getAllByRole('row');
    expect(rows.find((r) => within(r).queryByText('Rounding favors caller'))).toBeTruthy();
    expect(rows.find((r) => within(r).queryByText('Spec mismatch'))).toBeTruthy();
    const mismatch = screen.getByRole('button', { name: /Spec mismatch/ });
    expect(mismatch).toHaveTextContent('Spec mismatch 2 (1 only rounding)');
  });

  it('the figures and the findings say how many mismatches are only round trips, and name each level', () => {
    render(
      <>
        <Figures board={board} />
        <Findings board={board} />
      </>,
    );
    expect(screen.getByText(/1 of them only round trips, a SHOULD/)).toBeInTheDocument();
    const findings = screen.getByRole('region', { name: 'Where vaults disagree with EIP-4626' });
    expect(within(findings).getAllByText('EIP-4626 SHOULD')).toHaveLength(4);
    expect(within(findings).getAllByText('EIP-4626 MUST')).toHaveLength(1);
  });
});
