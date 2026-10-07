import type { AttestationRecord, AttestationStatusName, AttestationView, RegistryRead, StatusCounts } from './types';

/*
 * Reads CheckAttestationRegistry on Monad testnet at build time (view calls only, eth_call). A failed read never
 * fails the build: the registry is marked "error" and every vault shows "could not read attestation status".
 */

export const ATTESTATION_CHAIN_ID = 10143;
export const DEFAULT_ATTESTATION_REGISTRY = '0x3754918bBB8481D046D80718a9efe434e353daF7';
export const DEFAULT_ATTESTATION_RPC = 'https://testnet-rpc.monad.xyz';
/** keccak256("erc4626"), the registry's standardId (ADR 0004). */
export const ERC4626_STANDARD_ID = '0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab';
/**
 * Transaction pages. Checked on 2026-09-30 with the first attestation's tx: testnet.monadscan.com/tx/<hash>
 * serves the transaction (registry address and status visible without a browser challenge), while
 * testnet.monadexplorer.com/tx/<hash> answers 308 to testnet.monadvision.com/tx/<hash>, which is behind a
 * browser challenge and could not be confirmed from a script.
 */
export const TX_EXPLORER_BASE = 'https://testnet.monadscan.com/tx/';
export const ADDRESS_EXPLORER_BASE = 'https://testnet.monadscan.com/address/';

const STATUS_NAMES: readonly AttestationStatusName[] = ['None', 'Valid', 'Superseded', 'Revoked'];
const MAX_ATTESTATIONS = 2000;
// Monad's public testnet RPC answers "requests limited to 15/sec" above that rate; two readers stay well under it.
const CONCURRENCY = 2;

export interface RegistryReader {
  readContract(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

/** The Attestation struct as viem decodes it (named tuple fields). */
export interface RawAttestation {
  subjectChainId: bigint;
  subject: string;
  standardId: string;
  blockNumber: bigint;
  implementationKey: string;
  subjectCodeHash: string;
  suiteHash: string;
  reportHash: string;
  passCount: number | bigint;
  failCount: number | bigint;
  inconclusiveCount: number | bigint;
  notApplicableCount: number | bigint;
  issuedAt: bigint;
  issuer: string;
  status: number | bigint;
  reportURI: string;
  /** Bit i set: property i failed. Present whenever the full struct was read. */
  failedBitmap?: bigint | string;
}

export interface ReadAttestationsInput {
  /** null skips reading; `skippedBecause` says why. */
  client: RegistryReader | null;
  skippedBecause?: string;
  abi: readonly unknown[];
  registry: { chainId: number; address: string; rpc: string };
  standardId: string;
  subjects: ReadonlyArray<{ chainId: number; address: string }>;
  /** Registry-scoped attestation id -> transaction hash, from data/attestation-txs.json. */
  txHashes?: Readonly<Record<string, string>>;
  maxAttestations?: number;
  now?: () => Date;
}

export interface AttestationReadResult {
  registry: RegistryRead;
  /** Keyed by `<chainId>/<address lowercase>`; only subjects that have an attestation. */
  bySubject: Map<string, AttestationRecord>;
}

function subjectKey(chainId: number | bigint, address: string): string {
  return `${chainId}/${address.toLowerCase()}`;
}

function num(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

export function toRecord(id: bigint, a: RawAttestation, compliant: boolean | null, txHashes?: Readonly<Record<string, string>>): AttestationRecord {
  const counts: StatusCounts = {
    pass: num(a.passCount),
    fail: num(a.failCount),
    inconclusive: num(a.inconclusiveCount),
    notApplicable: num(a.notApplicableCount),
  };
  return {
    id: id.toString(),
    status: STATUS_NAMES[num(a.status)] ?? 'None',
    compliant,
    blockNumber: a.blockNumber.toString(),
    reportHash: a.reportHash,
    suiteHash: a.suiteHash,
    implementationKey: a.implementationKey,
    subjectCodeHash: a.subjectCodeHash,
    counts,
    issuedAt: new Date(Number(a.issuedAt) * 1000).toISOString(),
    issuer: a.issuer,
    reportURI: a.reportURI,
    txHash: txHashes?.[id.toString()] ?? null,
    ...(a.failedBitmap !== undefined ? { failedBitmap: `0x${BigInt(a.failedBitmap).toString(16)}` } : {}),
  };
}

/** Short, single-line error text with URLs masked, for data/board.json and the page. */
export function describeReadError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  const text = String(e?.shortMessage ?? e?.message ?? err ?? 'unknown error');
  const line = text.split('\n').find((l) => l.trim()) ?? text;
  return line.replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 200);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * attestationCount(), then attestationOf(id) for each id (the most recent `maxAttestations` of them), then, for
 * every board vault that has one, latest() and isCompliant(). Calls scale with the attestations, not with the
 * board: with one attestation on the registry this is four eth_calls.
 */
export async function readAttestations(i: ReadAttestationsInput): Promise<AttestationReadResult> {
  const readAt = (i.now ?? (() => new Date()))().toISOString();
  const base = { chainId: i.registry.chainId, address: i.registry.address, rpc: i.registry.rpc };
  if (!i.client) {
    return {
      registry: { ...base, status: 'skipped', error: i.skippedBecause ?? 'registry reading switched off', attestationCount: null, readAt: null },
      bySubject: new Map(),
    };
  }
  const client = i.client;
  const address = i.registry.address as `0x${string}`;
  const read = (functionName: string, args?: readonly unknown[]) => client.readContract({ address, abi: i.abi, functionName, ...(args ? { args } : {}) });
  const wanted = new Set(i.subjects.map((s) => subjectKey(s.chainId, s.address)));
  const standardId = i.standardId.toLowerCase();

  try {
    const count = BigInt((await read('attestationCount')) as bigint);
    const max = BigInt(i.maxAttestations ?? MAX_ATTESTATIONS);
    const from = count > max ? count - max : 0n;
    const ids: bigint[] = [];
    for (let id = from; id < count; id++) ids.push(id);
    const all = await mapLimit(ids, CONCURRENCY, async (id) => ({ id, a: (await read('attestationOf', [id])) as RawAttestation }));

    const found = new Map<string, { chainId: bigint; subject: string }>();
    for (const { a } of all) {
      if (a.standardId.toLowerCase() !== standardId) continue;
      const key = subjectKey(a.subjectChainId, a.subject);
      if (wanted.has(key)) found.set(key, { chainId: a.subjectChainId, subject: a.subject });
    }

    const bySubject = new Map<string, AttestationRecord>();
    await mapLimit([...found.entries()], CONCURRENCY, async ([key, s]) => {
      const [id, latest] = (await read('latest', [s.chainId, s.subject, i.standardId])) as readonly [bigint, RawAttestation];
      let compliant: boolean | null = null;
      try {
        compliant = (await read('isCompliant', [s.chainId, s.subject, i.standardId])) as boolean;
      } catch {
        compliant = null;
      }
      bySubject.set(key, toRecord(id, latest, compliant, i.txHashes));
    });

    return { registry: { ...base, status: 'ok', error: null, attestationCount: Number(count), readAt }, bySubject };
  } catch (err) {
    return {
      registry: { ...base, status: 'error', error: describeReadError(err), attestationCount: null, readAt },
      bySubject: new Map(),
    };
  }
}

/** Compares the latest attestation with the report on the board. */
export function attestationViewOf(
  registry: RegistryRead,
  record: AttestationRecord | undefined,
  report: { reportHash: string; suiteHash: string },
): AttestationView {
  if (registry.status !== 'ok') return { kind: 'unread', reason: registry.error ?? registry.status };
  if (!record) return { kind: 'none' };
  return {
    kind: 'attested',
    ...record,
    matchesReport: record.reportHash.toLowerCase() === report.reportHash.toLowerCase(),
    suiteMatches: record.suiteHash.toLowerCase() === report.suiteHash.toLowerCase(),
  };
}

export function txUrl(hash: string): string {
  return `${TX_EXPLORER_BASE}${hash}`;
}

export function addressUrl(address: string): string {
  return `${ADDRESS_EXPLORER_BASE}${address}`;
}
