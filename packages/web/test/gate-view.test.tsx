import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Log } from 'viem';
import { GateView, formatTokens } from '../components/watch/GateView';
import { allocationGateAbi, gateAddress } from '../lib/gate/contract';
import { gateEventsOf, readGateView, RECENT_LOG_BLOCKS, type GateChainReader } from '../lib/gate/read';
import { gatePageView } from '../lib/gate/service';

/* /watch/gate on a mock chain: what the reader asks for, what it makes of the answers, and what a reader sees. */

const GATE = getAddress('0x000000000000000000000000000000000009a7e0');
const REGISTRY = '0x3754918bBB8481D046D80718a9efe434e353daF7' as const;
const TOKEN = '0x00000000000000000000000000000000000070c0' as const;
const OWNER = '0x1111111111111111111111111111111111111111' as const;
const KEEPER = '0x2222222222222222222222222222222222222222' as const;
const ISSUER = '0x3333333333333333333333333333333333333333' as const;
const OK = '0xa000000000000000000000000000000000000001' as const;
const BROKEN = '0xa000000000000000000000000000000000000002' as const;
const NEW = '0xa000000000000000000000000000000000000003' as const;
const STD = '0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab' as const;
const E18 = 10n ** 18n;
const HEAD = 5_000n;
const NOW = 1_790_000_000n;

let logIndex = 0;
function log(eventName: 'Allocated' | 'Exited' | 'ExitFailed' | 'IdleWithdrawn', args: Record<string, unknown>, block: bigint, address: `0x${string}` = GATE): Log {
  const event = allocationGateAbi.find((x) => x.type === 'event' && x.name === eventName)! as { inputs: readonly { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi: allocationGateAbi, eventName, args } as never);
  const data = encodeAbiParameters(
    event.inputs.filter((i) => !i.indexed),
    event.inputs.filter((i) => !i.indexed).map((i) => args[i.name]),
  );
  return { address, topics, data, blockNumber: block, transactionHash: `0x${block.toString(16).padStart(64, '0')}`, logIndex: logIndex++, blockHash: null, transactionIndex: 0, removed: false } as unknown as Log;
}

function attestation(id: bigint, over: Record<string, unknown> = {}) {
  return [id, { subjectChainId: 10143n, subject: OK, standardId: STD, blockNumber: 4_000n, implementationKey: STD, subjectCodeHash: STD, suiteHash: STD, reportHash: STD, passCount: 30, failCount: 0, inconclusiveCount: 0, notApplicableCount: 0, issuedAt: NOW - 600n, issuer: ISSUER, status: 1, reportURI: 'x', ...over }] as const;
}

const allocatedOld = log('Allocated', { vault: BROKEN, attestationId: 4n, assets: 20n * E18, shares: 20n * E18 }, 1_200n);
const exited = log('Exited', { vault: BROKEN, attestationId: 7n, caller: KEEPER, verdict: 3, path: 0, shares: 20n * E18, assets: 21n * E18 }, 4_950n);
const allocatedNew = log('Allocated', { vault: OK, attestationId: 6n, assets: 10n * E18, shares: 10n * E18 }, 4_990n);
const foreign = log('Allocated', { vault: OK, attestationId: 6n, assets: 1n, shares: 1n }, 4_991n, '0x00000000000000000000000000000000000000ff');

function chain(over: { failLatestOf?: string; logsFail?: boolean } = {}) {
  const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
    if (over.logsFail && fromBlock !== toBlock) throw new Error('block range too large');
    return [allocatedOld, exited, allocatedNew, foreign].filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock);
  });
  const reader: GateChainReader & { getLogs: typeof getLogs } = {
    getBlock: async () => ({ number: HEAD, timestamp: NOW }),
    getLogs,
    readContract: async ({ address, functionName, args }) => {
      const v = (args?.[1] ?? args?.[0]) as string | undefined;
      if (address === GATE) {
        const answers: Record<string, unknown> = { registry: REGISTRY, subjectChainId: 10143n, standardId: STD, asset: TOKEN, owner: OWNER, maxAttestationAge: 86_400n, idle: 91n * E18, vaults: [BROKEN, OK, NEW] };
        if (functionName in answers) return answers[functionName];
        if (functionName === 'positionOf') {
          if (v === BROKEN) return { shares: 0n, assetsIn: 20n * E18, assetsOut: 21n * E18, lastAllocatedBlock: 1_200n, lastExitBlock: 4_950n };
          if (v === OK) return { shares: 10n * E18, assetsIn: 10n * E18, assetsOut: 0n, lastAllocatedBlock: 4_990n, lastExitBlock: 0n };
          return { shares: 5n * E18, assetsIn: 5n * E18, assetsOut: 0n, lastAllocatedBlock: 4_995n, lastExitBlock: 0n };
        }
        if (functionName === 'verdictOf') return v === OK ? [0, 6n] : v === BROKEN ? [3, 7n] : [4, 8n];
      }
      if (address === TOKEN) return functionName === 'symbol' ? 'sfTKN' : 18;
      if (address === REGISTRY) {
        if (functionName === 'latest') {
          if (v === over.failLatestOf) throw new Error('HTTP request failed: 429');
          if (v === BROKEN) return attestation(7n, { failCount: 1, passCount: 29 });
          if (v === NEW) return attestation(8n, { issuer: KEEPER });
          return attestation(6n);
        }
        if (functionName === 'isCompliant') return v === OK || v === NEW;
        if (functionName === 'isIssuer') return v === ISSUER;
      }
      throw new Error(`unexpected ${address}.${functionName}`);
    },
  };
  return reader;
}

afterEach(cleanup);

describe('gate reads', () => {
  it('reads the gate, each vault and its latest attestation, and only a few blocks of logs', async () => {
    const reader = chain();
    const view = await readGateView(reader, GATE);
    expect(view).toMatchObject({ registry: REGISTRY, asset: TOKEN, assetSymbol: 'sfTKN', assetDecimals: 18, owner: OWNER, idle: (91n * E18).toString(), head: '5000', now: NOW.toString(), errors: [] });
    expect(view.vaults.map((v) => [v.vault, v.verdict, v.canExit, v.compliant])).toEqual([
      [BROKEN, 'NotCompliant', false, false],
      [OK, 'Compliant', false, true],
      [NEW, 'UntrustedIssuer', true, true],
    ]);
    expect(view.vaults[0]!.attestation).toMatchObject({ id: '7', status: 'Valid', failCount: 1, issuerAllowed: true });
    expect(view.vaults[2]!.attestation).toMatchObject({ issuer: KEEPER, issuerAllowed: false });
    // One window at the head, then the one pointed-at block before it (1,200); the exit at 4,950 is in the window.
    expect(reader.getLogs.mock.calls.map(([a]) => [a.fromBlock, a.toBlock])).toEqual([
      [HEAD - RECENT_LOG_BLOCKS + 1n, HEAD],
      [1_200n, 1_200n],
    ]);
    expect(view.events.map((e) => [e.kind, e.blockNumber])).toEqual([
      ['Allocated', '4990'],
      ['Exited', '4950'],
      ['Allocated', '1200'],
    ]);
    expect(view.events[1]).toMatchObject({ kind: 'Exited', vault: BROKEN, caller: KEEPER, verdict: 'NotCompliant', path: 'Redeem', assets: (21n * E18).toString() });
  });

  it('a failed read is listed, never a guess; NoAttestation is not an error', async () => {
    const view = await readGateView(chain({ failLatestOf: OK, logsFail: true }), GATE);
    expect(view.vaults[1]!.attestation).toBeNull();
    expect(view.errors).toEqual([expect.stringMatching(/^latest attestation of 0xa0+1: HTTP request failed: 429/), expect.stringMatching(/^events in blocks 4901 to 5000: block range too large/)]);
    expect(view.events.map((e) => e.blockNumber)).toEqual(['1200']);
  });

  it('drops logs of other emitters', () => {
    expect(gateEventsOf(GATE, [foreign, allocatedNew]).map((e) => e.blockNumber)).toEqual(['4990']);
  });

  it('without NEXT_PUBLIC_SPECFIRST_GATE_10143 the gate is not deployed, and nothing is read', async () => {
    expect(gateAddress({})).toBeNull();
    expect(gateAddress({ NEXT_PUBLIC_SPECFIRST_GATE_10143: 'nope' })).toBeNull();
    expect(gateAddress({ NEXT_PUBLIC_SPECFIRST_GATE_10143: ` ${GATE.toLowerCase()} ` })).toBe(GATE);
    const client = { readContract: vi.fn() };
    expect(await gatePageView({}, client as never)).toEqual({ deployed: false });
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it('formats token amounts without losing dust', () => {
    expect(formatTokens((1234n * E18 + E18 / 2n).toString(), 18)).toBe('1,234.5');
    expect(formatTokens('1', 18)).toBe('<0.0001');
    expect(formatTokens('0', 18)).toBe('0');
  });
});

describe('GateView', () => {
  it('says when no gate is deployed', () => {
    render(<GateView data={{ deployed: false }} />);
    expect(screen.getByText(/No allocation gate is deployed on Monad testnet yet/)).toBeInTheDocument();
  });

  it('shows each vault with its verdict, its attestation and whether anyone can exit, and the events', async () => {
    const view = await readGateView(chain(), GATE);
    render(<GateView data={{ deployed: true, address: GATE, view, error: null }} />);
    const rows = screen.getAllByRole('row');
    const broken = rows.find((r) => within(r).queryByText('Not compliant'))!;
    expect(within(broken).getByText(/29 pass, 1 fail, 0 inconclusive, 0 n\/a; 10 min ago/)).toBeInTheDocument();
    expect(within(broken).getByText('nothing held')).toBeInTheDocument();
    const removed = rows.find((r) => within(r).queryByText('Issuer removed'))!;
    expect(within(removed).getByText('open to anyone')).toBeInTheDocument();
    expect(within(removed).getByText(/no longer an issuer/)).toBeInTheDocument();
    expect(screen.getByText(/21 back by redeem of 20 shares; verdict not compliant, attestation #7/)).toBeInTheDocument();
    expect(screen.getByText(/not the owner/)).toBeInTheDocument();
    expect(screen.getByText('91 sfTKN')).toBeInTheDocument();
  });

  it('says why the gate could not be read', () => {
    render(<GateView data={{ deployed: true, address: GATE, view: null, error: 'HTTP request failed' }} />);
    expect(screen.getByText(/Could not read the gate at/)).toHaveTextContent('HTTP request failed');
  });
});
