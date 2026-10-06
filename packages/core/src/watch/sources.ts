// Signal sources of the watcher as data (docs/adr/0006, "Signals"): which emitter, which event, which
// argument names the vault. Built in for Monad mainnet (143); any chain can be given its own list in a JSON
// file (`specfirst watch --sources <file>`). Only viem and zod are imported (browser-safe).
import { decodeEventLog, getAddress, parseAbiItem, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem';
import { z } from 'zod';

const checksum = (a: string): Address => getAddress(a.toLowerCase());

/**
 * factory: the event names a newly created vault (argument `vault`). deposit, upgrade, beacon-upgrade: the
 * emitter is the subject (ERC-4626 Deposit, EIP-1967 Upgraded and BeaconUpgraded). implementation: the
 * emitter is a beacon (the EVK GenericFactory) whose new implementation every vault resolving through it
 * now runs.
 */
export const WATCH_SIGNALS = ['factory', 'deposit', 'upgrade', 'beacon-upgrade', 'implementation'] as const;
export type WatchSignal = (typeof WATCH_SIGNALS)[number];

export interface WatchSource {
  name: string;
  signal: WatchSignal;
  /** The emitter this source listens to; null for any emitter (the generic signals). */
  address: Address | null;
  topic0: Hex;
  event: AbiEvent;
  /** The event argument holding the new vault (factory sources); null when the emitter is the subject or a beacon. */
  vault: string | null;
  /** For an emitter-less source: whether an unknown emitter becomes a candidate. Signals of known vaults always count. */
  candidates: boolean;
}

/** A vault a factory source must decode at a known block: the source's creation event in that block names it. */
export interface SourceFixture {
  source: string;
  block: bigint;
  vault: Address;
  /** The creation log itself (topics and data), when the file carries it: checked offline as the file is read. */
  log?: { topics: Hex[]; data: Hex };
}

export class SourcesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourcesError';
  }
}

export interface SourceSpec {
  name: string;
  signal: WatchSignal;
  address: string | null;
  /** Human-readable event signature, e.g. `event Deposit(address indexed sender, ...)`, with indexed flags. */
  event: string;
  vault: string | null;
  candidates?: boolean;
  /** When given, must equal the selector of `event`: a cross-check against a typo in the signature. */
  topic0?: string;
}

/** Builds a WatchSource from its spec, checking the vault argument and the per-signal rules. */
export function sourceOf(spec: SourceSpec): WatchSource {
  let event: AbiEvent;
  try {
    const item = parseAbiItem(spec.event) as { type?: string };
    if (item.type !== 'event') throw new Error('not an event');
    event = item as AbiEvent;
  } catch (err) {
    throw new SourcesError(`source "${spec.name}": "${spec.event}" is not an event signature: ${(err as Error).message.split('\n')[0]}`);
  }
  const topic0 = toEventSelector(event);
  if (spec.topic0 !== undefined && spec.topic0.toLowerCase() !== topic0) {
    throw new SourcesError(`source "${spec.name}": topic0 ${spec.topic0} is not the selector of ${spec.event} (${topic0})`);
  }
  if (spec.address !== null && !/^0x[0-9a-fA-F]{40}$/.test(spec.address)) throw new SourcesError(`source "${spec.name}": address ${spec.address} is not an address`);
  const address = spec.address === null ? null : checksum(spec.address);
  if (spec.signal === 'factory') {
    if (!address) throw new SourcesError(`source "${spec.name}": a factory source needs the factory's address`);
    const input = event.inputs.find((i) => i.name === spec.vault);
    if (!spec.vault || !input) throw new SourcesError(`source "${spec.name}": vault must name an argument of ${spec.event}`);
    if (input.type !== 'address') throw new SourcesError(`source "${spec.name}": argument ${spec.vault} is ${input.type}, not address`);
  } else {
    if (spec.vault !== null) throw new SourcesError(`source "${spec.name}": only factory sources name a vault argument; for ${spec.signal} the emitter is the subject`);
    if (spec.signal === 'implementation' && !address) throw new SourcesError(`source "${spec.name}": an implementation source needs the beacon's address`);
  }
  return { name: spec.name, signal: spec.signal, address, topic0, event, vault: spec.vault, candidates: spec.candidates ?? true };
}

/** The signals every chain has: ERC-4626 Deposit and EIP-1967 Upgraded and BeaconUpgraded from any emitter. */
export const GENERIC_SOURCE_SPECS: readonly SourceSpec[] = [
  { name: 'ERC-4626 Deposit', signal: 'deposit', address: null, event: 'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)', vault: null },
  { name: 'EIP-1967 Upgraded', signal: 'upgrade', address: null, event: 'event Upgraded(address indexed implementation)', vault: null },
  { name: 'EIP-1967 BeaconUpgraded', signal: 'beacon-upgrade', address: null, event: 'event BeaconUpgraded(address indexed beacon)', vault: null },
];

/**
 * Monad mainnet factories (docs/adr/0006, "Signals on Monad mainnet"), each verified against the fixtures
 * below. The EVK GenericFactory is also the beacon of upgradeable EVK vaults: SetImplementation (euler-vault-kit
 * src/GenericFactory/GenericFactory.sol, `event SetImplementation(address indexed newImplementation)`,
 * emitted on chain at 30858657 with the implementation EVK vaults resolve to) moves all of them at once.
 */
export const MONAD_MAINNET_SOURCE_SPECS: readonly SourceSpec[] = [
  {
    name: 'Euler EVK GenericFactory',
    signal: 'factory',
    address: '0xba4Dd672062dE8FeeDb665DD4410658864483f1E',
    event: 'event ProxyCreated(address indexed proxy, bool upgradeable, address implementation, bytes trailingData)',
    vault: 'proxy',
  },
  {
    name: 'Morpho VaultV2Factory',
    signal: 'factory',
    address: '0x8b2f922162fbb60a6a072cc784a2e4168fb0bb0c',
    event: 'event CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed newVaultV2)',
    vault: 'newVaultV2',
  },
  {
    name: 'MetaMorpho V1.1 factory',
    signal: 'factory',
    address: '0x33f20973275b2f574488b18929cd7dcbf1abf275',
    event:
      'event CreateMetaMorpho(address indexed metaMorpho, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)',
    vault: 'metaMorpho',
  },
  {
    name: 'Euler Earn factory',
    signal: 'factory',
    address: '0xf463d4acb650cc6c4e1d6cd4d0d1b0cb224094cf',
    event:
      'event CreateEulerEarn(address indexed eulerEarn, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)',
    vault: 'eulerEarn',
  },
  {
    name: 'Neverland static wrapper factory',
    signal: 'factory',
    address: '0x81148e8e1d9910080317e11c9f178559ba23bc80',
    event: 'event StaticTokenCreated(address indexed staticToken, address indexed underlying)',
    vault: 'staticToken',
  },
  {
    name: 'Euler EVK GenericFactory implementation',
    signal: 'implementation',
    address: '0xba4Dd672062dE8FeeDb665DD4410658864483f1E',
    event: 'event SetImplementation(address indexed newImplementation)',
    vault: null,
  },
];

/** The ADR's fixtures: for each factory, vaults whose creation block holds the factory event naming them. */
export const MONAD_MAINNET_SOURCE_FIXTURES: readonly SourceFixture[] = [
  { source: 'Euler EVK GenericFactory', block: 38331148n, vault: checksum('0x69b4A7829F6BAE4e0c3C281aA7026D897fEC199F') },
  { source: 'Morpho VaultV2Factory', block: 108743758n, vault: checksum('0x91643f54C4F5F7559BD43a082eFF97594d16708C') },
  { source: 'Morpho VaultV2Factory', block: 73672212n, vault: checksum('0xbeef067c9d2591accab7d1c336a41ca3bd45b8f5') },
  { source: 'Morpho VaultV2Factory', block: 110391543n, vault: checksum('0xde16452c1f8cc209d8e9b104b7f240d9a251768b') },
  { source: 'Morpho VaultV2Factory', block: 110930586n, vault: checksum('0xbd6d56b5b1b535b92d4a0a8c0a9e6cfd9b545167') },
  { source: 'MetaMorpho V1.1 factory', block: 62600546n, vault: checksum('0xA35189d1a1d1d42BB7BA56E6d979D6Bb34fFeED7') },
  { source: 'Euler Earn factory', block: 36248205n, vault: checksum('0x9D42b0D57e88771B365e30c0A589Fcdbeca8828c') },
  { source: 'Neverland static wrapper factory', block: 54765321n, vault: checksum('0xD45D54ad7Ae6D5dEdb0De7B283Fe0b4e2ba40217') },
];

export const GENERIC_SOURCES: readonly WatchSource[] = GENERIC_SOURCE_SPECS.map(sourceOf);
export const MONAD_MAINNET_SOURCES: readonly WatchSource[] = MONAD_MAINNET_SOURCE_SPECS.map(sourceOf);

/** The built-in list of a subject chain: the Monad mainnet factories on 143, the generic signals everywhere. */
export function builtinSources(chainId: number): { sources: WatchSource[]; fixtures: SourceFixture[] } {
  if (chainId === 143) return { sources: [...MONAD_MAINNET_SOURCES, ...GENERIC_SOURCES], fixtures: [...MONAD_MAINNET_SOURCE_FIXTURES] };
  return { sources: [...GENERIC_SOURCES], fixtures: [] };
}

const addressString = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address');

const sourceSpecSchema = z
  .object({
    name: z.string().min(1),
    signal: z.enum(WATCH_SIGNALS),
    address: addressString.nullable(),
    event: z.string().min(1),
    vault: z.string().min(1).nullable(),
    candidates: z.boolean().optional(),
    topic0: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  })
  .strict();

/**
 * A `--sources` file: the whole source list of one subject chain (it replaces the built-in list), and
 * optional fixtures. A fixture with its `log` is decoded as the file is read; one without is read from the
 * chain when the watcher starts (and by `specfirst watch sources --verify`). Either way a source that does not
 * decode its fixture is refused.
 */
export const sourcesFileSchema = z
  .object({
    v: z.literal(1),
    chainId: z.number().int().positive(),
    description: z.string().optional(),
    sources: z.array(sourceSpecSchema).min(1),
    fixtures: z
      .array(
        z
          .object({
            source: z.string().min(1),
            block: z.string().regex(/^(0|[1-9]\d*)$/),
            vault: addressString,
            log: z.object({ topics: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/)).min(1), data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/) }).strict().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type SourcesFile = z.infer<typeof sourcesFileSchema>;

/** Validates a parsed `--sources` file for `chainId`. Throws SourcesError naming the problem. */
export function sourcesFromFile(json: unknown, chainId: number): { sources: WatchSource[]; fixtures: SourceFixture[] } {
  const parsed = sourcesFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new SourcesError(`not a sources file: ${issues.join('; ')}`);
  }
  const file = parsed.data;
  if (file.chainId !== chainId) throw new SourcesError(`the sources file is for chain ${file.chainId}, the subject chain is ${chainId}`);
  const sources = file.sources.map(sourceOf);
  const names = new Set<string>();
  for (const s of sources) {
    if (names.has(s.name)) throw new SourcesError(`two sources are named "${s.name}"`);
    names.add(s.name);
  }
  const fixtures = (file.fixtures ?? []).map((f): SourceFixture => {
    if (!names.has(f.source)) throw new SourcesError(`fixture names source "${f.source}", which the file does not list`);
    const fixture: SourceFixture = { source: f.source, block: BigInt(f.block), vault: checksum(f.vault), ...(f.log ? { log: { topics: f.log.topics as Hex[], data: f.log.data as Hex } } : {}) };
    if (fixture.log) {
      // A source that does not decode its own fixture would watch for nothing (or for the wrong address).
      const source = sources.find((s) => s.name === f.source)!;
      const signal = source.address
        ? decodeSignal({ address: source.address, topics: fixture.log.topics, data: fixture.log.data, blockNumber: fixture.block, transactionHash: `0x${'00'.repeat(32)}`, logIndex: 0 }, [source])
        : null;
      if (!signal || signal.subject !== fixture.vault) {
        throw new SourcesError(`source "${f.source}" does not decode its fixture at block ${f.block}: expected ${fixture.vault}, got ${signal?.subject ?? 'nothing'}`);
      }
    }
    return fixture;
  });
  return { sources, fixtures };
}

/** The topic0 values to ask eth_getLogs for (one filter, OR of topics, any emitter). */
export function signalTopics(sources: readonly WatchSource[]): Hex[] {
  return [...new Set(sources.map((s) => s.topic0))];
}

/** The part of an eth_getLogs entry the watcher reads. */
export interface SignalLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

export interface Signal {
  source: WatchSource;
  /** The vault (factory), the emitter (deposit, upgrade, beacon-upgrade) or the beacon (implementation). Checksummed. */
  subject: Address;
  block: bigint;
  txHash: Hex;
  logIndex: number;
  /** upgrade and beacon-upgrade: the new implementation or beacon the event names (its first indexed topic), when it is an address. */
  target?: Address;
}

/**
 * The signal a log carries, or null when no source matches it (another topic, another emitter) or a factory
 * event does not decode into an address. A source with an address wins over an emitter-less one. Only
 * factory events are decoded: a Deposit or Upgraded with another indexed layout still names its emitter.
 */
export function decodeSignal(log: SignalLog, sources: readonly WatchSource[]): Signal | null {
  const topic0 = log.topics[0]?.toLowerCase();
  if (!topic0) return null;
  const emitter = log.address.toLowerCase();
  const matching = sources.filter((s) => s.topic0 === topic0 && (s.address === null || s.address.toLowerCase() === emitter));
  const source = matching.find((s) => s.address !== null) ?? matching[0];
  if (!source) return null;
  const at = { block: log.blockNumber, txHash: log.transactionHash, logIndex: log.logIndex };
  if (source.signal !== 'factory') {
    const topic1 = log.topics[1];
    const named = (source.signal === 'upgrade' || source.signal === 'beacon-upgrade') && topic1 && /^0x0{24}[0-9a-fA-F]{40}$/.test(topic1);
    return { source, subject: getAddress(emitter), ...at, ...(named ? { target: getAddress(`0x${topic1.slice(26)}`) } : {}) };
  }
  try {
    const decoded = decodeEventLog({ abi: [source.event], data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    const vault = (decoded.args as Record<string, unknown>)[source.vault!];
    if (typeof vault !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(vault)) return null;
    return { source, subject: getAddress(vault), ...at };
  } catch {
    return null;
  }
}

/**
 * Checks one fixture: the logs of its source's emitter at its block (via `getLogs`) must hold an event of
 * that source naming the fixture's vault. Returns the vaults the source decoded at that block.
 */
export async function verifySourceFixture(
  fixture: SourceFixture,
  sources: readonly WatchSource[],
  getLogs: (q: { address: Address; topic0: Hex; block: bigint }) => Promise<SignalLog[]>,
): Promise<{ ok: boolean; decoded: Address[] }> {
  const source = sources.find((s) => s.name === fixture.source);
  if (!source || !source.address) throw new SourcesError(`fixture source "${fixture.source}" is not a source with an emitter`);
  const logs = await getLogs({ address: source.address, topic0: source.topic0, block: fixture.block });
  const decoded = logs.map((l) => decodeSignal(l, [source])).filter((s): s is Signal => s !== null).map((s) => s.subject);
  return { ok: decoded.includes(checksum(fixture.vault)), decoded };
}
