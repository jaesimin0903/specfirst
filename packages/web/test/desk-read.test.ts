import { describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex } from 'viem';
import { checkRequestDeskAbi } from '../lib/desk/contract';
import { isUnknownRequest, latestIds, normalizeRequest, readDeskSummary, readRequest, readRequests, type ContractReader } from '../lib/desk/read';
import { requestIdFromLogs, walletErrorMessage } from '../lib/desk/wallet';

const DESK = '0x00000000000000000000000000000000000d35c0' as const;
const VAULT = '0xd793c04b87386a6bb84ee61d98e0065fde7fda5e' as const;
const REQUESTER = '0x1111111111111111111111111111111111111111' as const;
const FEE = 10n ** 17n;
const STD = keccak256(toHex('erc4626'));

function raw(status: number, over: Record<string, unknown> = {}) {
  return { requester: REQUESTER, subjectChainId: 143n, subject: VAULT, standardId: STD, fee: FEE, requestedAt: 1_790_000_000n, status, attestationId: 0n, rejectReason: `0x${'0'.repeat(64)}`, ...over };
}

function unknownRequest(id: bigint) {
  const err = new Error('The contract function "requestOf" reverted.') as Error & { cause: unknown };
  err.cause = { data: { errorName: 'UnknownRequest', args: [id] } };
  return err;
}

function reader(behavior: Record<string, (args?: readonly unknown[]) => unknown>): ContractReader & { readContract: ReturnType<typeof vi.fn> } {
  return {
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      const f = behavior[functionName];
      if (!f) throw new Error(`unexpected ${functionName}`);
      return f(args);
    }),
  };
}

describe('desk reads', () => {
  it('normalizes the Request struct, named or positional', () => {
    const named = normalizeRequest(3n, raw(2, { attestationId: 18n }));
    expect(named).toMatchObject({ id: 3n, status: 'Fulfilled', feeWei: FEE, subjectChainId: 143, attestationId: 18n, requestedAt: 1_790_000_000n });
    const r = raw(1);
    const positional = normalizeRequest(3n, [r.requester, r.subjectChainId, r.subject, r.standardId, r.fee, r.requestedAt, r.status, r.attestationId, r.rejectReason]);
    expect(positional.status).toBe('Pending');
    expect(positional.subject).toBe(VAULT);
  });

  it('an unknown id is null, whether it reverts UnknownRequest or returns a zeroed struct; other errors propagate', async () => {
    expect(await readRequest(reader({ requestOf: (a) => Promise.reject(unknownRequest(a![0] as bigint)) }), DESK, 9n)).toBeNull();
    expect(await readRequest(reader({ requestOf: () => raw(0) }), DESK, 9n)).toBeNull();
    await expect(readRequest(reader({ requestOf: () => Promise.reject(new Error('HTTP request failed')) }), DESK, 9n)).rejects.toThrow('HTTP request failed');
    expect(isUnknownRequest({ shortMessage: 'reverted with UnknownRequest(9)' })).toBe(true);
  });

  it('ids run 0..requestCount-1, newest first', () => {
    expect(latestIds(3n, 10)).toEqual([2n, 1n, 0n]);
    expect(latestIds(500n, 3)).toEqual([499n, 498n, 497n]);
    expect(latestIds(0n, 5)).toEqual([]);
  });

  it('readRequests leaves out ids that fail', async () => {
    const r = reader({ requestOf: (a) => ((a![0] as bigint) === 1n ? Promise.reject(new Error('rate limited')) : raw(1)) });
    const out = await readRequests(r, DESK, [2n, 1n, 0n]);
    expect(out.map((x) => x.id)).toEqual([2n, 0n]);
  });

  it('the summary keeps what it could read and lists what it could not', async () => {
    const r = reader({
      fee: () => FEE,
      timeout: () => 3600n,
      requestCount: () => 4n,
      earned: () => 2n * FEE,
      withdrawn: () => 0n,
      escrowed: () => Promise.reject(new Error('execution reverted')),
      owner: () => REQUESTER,
      worker: () => REQUESTER,
      registry: () => '0x3754918bBB8481D046D80718a9efe434e353daF7',
    });
    const s = await readDeskSummary(r, DESK);
    expect(s).toMatchObject({ feeWei: FEE, timeoutSec: 3600n, requestCount: 4n, earnedWei: 2n * FEE, escrowedWei: null });
    expect(s.errors).toEqual(['escrowed: execution reverted']);
    await expect(readDeskSummary(reader({}), DESK)).rejects.toThrow(/desk not reachable/);
  });
});

describe('request id from the receipt', () => {
  const topics = encodeEventTopics({ abi: checkRequestDeskAbi, eventName: 'CheckRequested', args: { id: 5n, requester: REQUESTER, subject: getAddress(VAULT) } }) as [
    `0x${string}`,
    ...`0x${string}`[],
  ];
  const data = encodeAbiParameters([{ type: 'uint64' }, { type: 'bytes32' }, { type: 'uint96' }], [143n, STD, FEE]);

  it('reads the id from the desk CheckRequested log and ignores other contracts', () => {
    const other = { address: '0x0000000000000000000000000000000000000bad' as const, data, topics };
    expect(requestIdFromLogs([other, { address: DESK, data, topics }], DESK)).toBe(5n);
    expect(requestIdFromLogs([other], DESK)).toBeNull();
  });

  it('wallet errors become one sentence', () => {
    expect(walletErrorMessage({ code: 4001, message: 'User rejected the request.' })).toBe('You declined in the wallet. Nothing was sent.');
    expect(walletErrorMessage(new Error('insufficient funds for gas * price + value'))).toMatch(/Not enough testnet MON/);
    expect(walletErrorMessage({ shortMessage: 'HTTP request failed.\n\nURL: https://testnet-rpc.monad.xyz' })).toBe('HTTP request failed.');
  });
});
