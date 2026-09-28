import { createPublicClient, http, type Address, type Chain, type Hex, type PublicClient } from 'viem';
import type { Command } from 'commander';
import pc from 'picocolors';
import { contextFrom, emitEvent, printLine } from '../lib/context.js';
import certificateRegistryAbi from '../abi/CertificateRegistry.json' with { type: 'json' };

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const DEFAULT_RPC = 'https://testnet-rpc.monad.xyz';
export const REGISTRY_ENV_VAR = `SPECFIRST_REGISTRY_${MONAD_TESTNET_CHAIN_ID}`;
export const RPC_ENV_VAR = 'MONAD_TESTNET_RPC';

const STATUS_NAMES = ['None', 'Valid', 'Superseded', 'Revoked'] as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const monadTestnet = {
  id: MONAD_TESTNET_CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC] } },
} as const satisfies Chain;

export interface CertificateStruct {
  projectId: Hex;
  specHash: Hex;
  invariantSetHash: Hex;
  propertyHash: Hex;
  codeHash: Hex;
  reportHash: Hex;
  issuedAt: bigint;
  passedCount: number;
  totalCount: number;
  passedBitmap: bigint;
  rehearsalTxCount: number;
  status: number;
  supersededBy: Address;
  revokeReasonHash: Hex;
  reportURI: string;
}

export interface StatusResult {
  address: Address;
  chainId: number;
  registry: Address;
  hasCertificate: boolean;
  certified: boolean;
  certifiedWith: boolean | null;
  isLatest: boolean | null;
  certId: bigint | null;
  certificate: CertificateStruct | null;
  codeMatches: boolean | null;
}

/** The slice of viem's PublicClient that fetchStatus needs; lets tests pass a mock. */
export interface MinimalPublicClient {
  readContract: PublicClient['readContract'];
}

export interface FetchStatusInput {
  client: MinimalPublicClient;
  registry: Address;
  address: Address;
  invariantSetHash?: Hex;
}

/**
 * True when `err` is (or wraps, via .cause or viem's BaseError#walk) a revert whose decoded
 * custom error is NoCertificate. Written without a hard dependency on viem's error classes so
 * tests can simulate the revert with a plain mock error shaped like { data: { errorName } }.
 */
function isNoCertificateRevert(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const c = current as { data?: { errorName?: string }; cause?: unknown; walk?: (fn: (e: unknown) => boolean) => unknown };
    if (c.data?.errorName === 'NoCertificate') return true;
    if (typeof c.walk === 'function') {
      const found = c.walk((e) => (e as { data?: { errorName?: string } })?.data?.errorName === 'NoCertificate');
      if (found) return true;
    }
    current = c.cause;
  }
  return false;
}

/**
 * Reads isCertified, isCertifiedWith (when invariantSetHash given), latest, and isLatest
 * from CertificateRegistry for one target. When latest() reverts with NoCertificate,
 * hasCertificate is false and isLatest/certId/certificate/codeMatches stay null
 * (per plan.md 3.10: "no certificate" is not an error, CLI still exits 0).
 */
export async function fetchStatus({ client, registry, address, invariantSetHash }: FetchStatusInput): Promise<StatusResult> {
  const certified = (await client.readContract({
    address: registry,
    abi: certificateRegistryAbi,
    functionName: 'isCertified',
    args: [address],
  })) as boolean;

  const certifiedWith = invariantSetHash
    ? ((await client.readContract({
        address: registry,
        abi: certificateRegistryAbi,
        functionName: 'isCertifiedWith',
        args: [address, invariantSetHash],
      })) as boolean)
    : null;

  let latestResult: readonly [bigint, CertificateStruct, boolean] | null = null;
  try {
    latestResult = (await client.readContract({
      address: registry,
      abi: certificateRegistryAbi,
      functionName: 'latest',
      args: [address],
    })) as readonly [bigint, CertificateStruct, boolean];
  } catch (err) {
    if (!isNoCertificateRevert(err)) throw err;
  }

  const base = { address, chainId: MONAD_TESTNET_CHAIN_ID, registry, certified, certifiedWith };

  if (!latestResult) {
    return { ...base, hasCertificate: false, isLatest: null, certId: null, certificate: null, codeMatches: null };
  }

  const [certId, certificate, codeMatches] = latestResult;
  const isLatest = (await client.readContract({
    address: registry,
    abi: certificateRegistryAbi,
    functionName: 'isLatest',
    args: [address],
  })) as boolean;

  return { ...base, hasCertificate: true, isLatest, certId, certificate, codeMatches };
}

/** Renders a StatusResult as aligned key: value lines for human-readable (non --json) output. */
export function formatStatus(result: StatusResult): string[] {
  const lines: string[] = [];
  lines.push(`${pc.bold('address:')}       ${result.address}`);
  lines.push(`${pc.bold('chainId:')}       ${result.chainId}`);
  lines.push(`${pc.bold('registry:')}      ${result.registry}`);
  lines.push(`${pc.bold('certified:')}     ${result.certified}`);
  if (result.certifiedWith !== null) {
    lines.push(`${pc.bold('certifiedWith:')} ${result.certifiedWith}`);
  }
  if (!result.hasCertificate) {
    lines.push('no certificate');
    return lines;
  }
  const cert = result.certificate!;
  lines.push(`${pc.bold('isLatest:')}      ${result.isLatest}`);
  lines.push(`${pc.bold('codeMatches:')}   ${result.codeMatches}`);
  lines.push(`${pc.bold('certId:')}        ${result.certId}`);
  lines.push(`${pc.bold('status:')}        ${STATUS_NAMES[cert.status] ?? cert.status}`);
  lines.push(`${pc.bold('passed:')}        ${cert.passedCount}/${cert.totalCount}`);
  lines.push(`${pc.bold('invariantSetHash:')} ${cert.invariantSetHash}`);
  lines.push(`${pc.bold('propertyHash:')}  ${cert.propertyHash}`);
  lines.push(`${pc.bold('issuedAt:')}      ${new Date(Number(cert.issuedAt) * 1000).toISOString()}`);
  lines.push(`${pc.bold('supersededBy:')}  ${cert.supersededBy === ZERO_ADDRESS ? '(none)' : cert.supersededBy}`);
  return lines;
}

export function registerStatusCommand(program: Command): void {
  program
    .command('status <address>')
    .description('Read on-chain certification status for a target from CertificateRegistry.')
    .option('--invariant-set-hash <hash>', 'also check isCertifiedWith against this invariantSetHash')
    .option('--rpc <url>', `JSON-RPC endpoint (default: $${RPC_ENV_VAR} or ${DEFAULT_RPC})`)
    .option('--registry <address>', `CertificateRegistry address (default: $${REGISTRY_ENV_VAR})`)
    .action(
      async (
        address: string,
        opts: { invariantSetHash?: string; rpc?: string; registry?: string },
        command: Command,
      ) => {
        const ctx = contextFrom(command);

        const registry = (opts.registry ?? process.env[REGISTRY_ENV_VAR]) as Address | undefined;
        if (!registry) {
          console.error(`specfirst status: no registry address. Set ${REGISTRY_ENV_VAR} or pass --registry <address>.`);
          process.exitCode = 1;
          return;
        }
        const rpcUrl = opts.rpc ?? process.env[RPC_ENV_VAR] ?? DEFAULT_RPC;
        const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });

        const result = await fetchStatus({
          client,
          registry,
          address: address as Address,
          invariantSetHash: opts.invariantSetHash as Hex | undefined,
        });

        emitEvent(ctx, { type: 'status', ...result });
        if (!ctx.json) {
          for (const line of formatStatus(result)) printLine(ctx, line);
        }
      },
    );
}
