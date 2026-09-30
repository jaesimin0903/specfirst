import type { VaultDetail } from './types';

/* The `specfirst check` command that replays a report. Shared by the vault page, the desk result card and the API. */

const CHAIN_NAME: Record<number, string> = { 143: 'Monad mainnet', 10143: 'Monad testnet', 31337: 'anvil' };
const NETWORK_FLAG: Record<number, string> = { 10143: ' --network monad-testnet', 31337: ' --network anvil' };

export function chainName(chainId: number): string {
  return CHAIN_NAME[chainId] ?? `chain ${chainId}`;
}

/** The arguments of `specfirst check` that replay a report: recorded block, runs, seed and (when not 0) delta. */
export function reproduceArgs(r: VaultDetail['report']): string[] {
  const args = [`specfirst check ${r.address}`, `--standard ${r.standard}`, `--block ${r.blockNumber}`, `--runs ${r.runs}`];
  if (r.seed) args.push(`--seed ${r.seed}`);
  if (r.delta !== '0') args.push(`--delta ${r.delta}`);
  const net = NETWORK_FLAG[r.chainId];
  if (net) args.push(net.trim());
  return args;
}

/** One line, as the README and ADR 0004 write it. */
export function reproduceCommand(r: VaultDetail['report']): string {
  return reproduceArgs(r).join(' ');
}

/** The same command over several lines with shell continuations, for the page and the copy button. */
export function reproduceCommandMultiline(r: VaultDetail['report']): string {
  return reproduceArgs(r).join(' \\\n  ');
}
