import { describe, expect, it } from 'vitest';
import { toFunctionSignature, toEventSignature, type AbiEvent, type AbiFunction } from 'viem';
import {
  checkRequestDeskAbi,
  decodeRejectCode,
  FIRST_REQUEST_ID,
  REQUEST_STATUS,
  rejectReasonText,
  workerRequestStatusSchema,
  workerStatusSchema,
} from '../lib/desk/contract';
import { parseWorkerStatus } from '../lib/desk/worker';

/*
 * lib/desk/contract.ts is written from the agreed CheckRequestDesk interface until @specfirst/core/desk exports
 * the real ABI. These pin what the web relies on, so the swap shows up here if the two disagree.
 */

describe('local CheckRequestDesk ABI', () => {
  const abi = checkRequestDeskAbi as readonly { type: string }[];
  const fns = abi.filter((x) => x.type === 'function').map((f) => toFunctionSignature(f as AbiFunction));
  const events = abi.filter((x) => x.type === 'event').map((e) => toEventSignature(e as AbiEvent));

  it('has the calls the pages make', () => {
    expect(fns).toEqual(
      expect.arrayContaining([
        'requestCheck(uint64,address,bytes32)',
        'refundExpired(uint256)',
        'requestOf(uint256)',
        'requestCount()',
        'fee()',
        'timeout()',
        'earned()',
        'withdrawn()',
        'escrowed()',
        'owner()',
        'worker()',
        'registry()',
      ]),
    );
    const requestCheck = checkRequestDeskAbi.find((x) => x.type === 'function' && x.name === 'requestCheck') as AbiFunction;
    expect(requestCheck.stateMutability).toBe('payable');
  });

  it('decodes requestOf as the Request struct, field by field', () => {
    const requestOf = checkRequestDeskAbi.find((x) => x.type === 'function' && x.name === 'requestOf') as AbiFunction;
    const out = requestOf.outputs[0] as { type: string; components: { name: string; type: string }[] };
    expect(out.type).toBe('tuple');
    expect(out.components.map((c) => `${c.type} ${c.name}`)).toEqual([
      'address requester',
      'uint64 subjectChainId',
      'address subject',
      'bytes32 standardId',
      'uint96 fee',
      'uint64 requestedAt',
      'uint8 status',
      'uint256 attestationId',
      'bytes32 rejectReason',
    ]);
  });

  it('has the four request events the web reads, with these exact signatures', () => {
    // The ABI is core's full contract ABI, so it also carries the owner events (FeeSet, WorkerSet, FeesWithdrawn).
    expect(events).toEqual(
      expect.arrayContaining([
        'CheckRequested(uint256,address,uint64,address,bytes32,uint96)',
        'CheckFulfilled(uint256,uint256)',
        'CheckRejected(uint256,bytes32)',
        'CheckRefunded(uint256)',
      ]),
    );
  });

  it('RequestStatus follows the Solidity enum and ids start at 0', () => {
    expect(REQUEST_STATUS).toEqual(['None', 'Pending', 'Fulfilled', 'Rejected', 'Refunded']);
    expect(FIRST_REQUEST_ID).toBe(0n);
  });
});

describe('reject codes', () => {
  const ascii = (s: string) => `0x${Buffer.from(s).toString('hex').padEnd(64, '0')}`;

  it('decodes right-padded ASCII and maps known codes to a sentence', () => {
    expect(decodeRejectCode(ascii('not-erc4626'))).toBe('not-erc4626');
    expect(rejectReasonText('not-erc4626')).toMatch(/not an ERC-4626 vault/);
    expect(rejectReasonText('check-failed')).toMatch(/could not run to the end/);
  });

  it('shows an unknown code as it is, and zero or garbage bytes without inventing text', () => {
    expect(rejectReasonText(decodeRejectCode(ascii('quota')))).toBe('The worker rejected the request with code "quota".');
    expect(decodeRejectCode(`0x${'0'.repeat(64)}`)).toBeNull();
    expect(decodeRejectCode(undefined)).toBeNull();
    const binary = `0x01ff${'0'.repeat(60)}`;
    expect(decodeRejectCode(binary)).toBe(binary);
  });
});

describe('worker status.json', () => {
  const sample = {
    '0': { stage: 'fulfilled', updatedAt: '2026-10-01T10:00:00.000Z', block: '109300000', attestationId: '18', txs: { attest: `0x${'a'.repeat(64)}`, fulfill: `0x${'b'.repeat(64)}` }, gasCostWei: '1200000000000000' },
    '1': { stage: 'running', updatedAt: 1790848800, txs: {} },
    '2': { stage: 'teleporting', updatedAt: 'x' },
    totals: { gasCostWei: '1200000000000000', fulfilled: 1, rejected: 0 },
  };

  it('the flat file parses with the schema: ids and totals side by side', () => {
    const parsed = workerStatusSchema.safeParse({ '0': sample['0'], '1': sample['1'], totals: sample.totals });
    expect(parsed.success).toBe(true);
    expect(workerRequestStatusSchema.safeParse(sample['2']).success).toBe(false);
  });

  it('parseWorkerStatus keeps the good entries when one is bad', () => {
    const snap = parseWorkerStatus(sample);
    expect(snap.available).toBe(true);
    expect([...snap.requests.keys()]).toEqual(['0', '1']);
    expect(snap.requests.get('0')!.attestationId).toBe('18');
    expect(snap.invalid).toEqual(['2']);
    expect(snap.totals).toEqual({ gasCostWei: 1200000000000000n, fulfilled: 1, rejected: 0 });
  });

  it('anything that is not an object is unavailable, not an error', () => {
    expect(parseWorkerStatus([]).available).toBe(false);
    expect(parseWorkerStatus(null).available).toBe(false);
  });
});
