import type { GateExitPath, GateVerdict } from './contract';

/*
 * What /watch/gate renders. Amounts, ids and block numbers are decimal strings (JSON has no bigint). Client-safe.
 */

export interface GateAttestationJson {
  id: string;
  status: 'None' | 'Valid' | 'Superseded' | 'Revoked';
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
  notApplicableCount: number;
  issuer: string;
  /** registry.isIssuer(issuer) now; null when the read failed. */
  issuerAllowed: boolean | null;
  /** unix seconds */
  issuedAt: string;
  /** subject chain block the suite ran at */
  blockNumber: string;
  reportURI: string;
}

export interface GateVaultJson {
  vault: string;
  shares: string;
  assetsIn: string;
  assetsOut: string;
  lastAllocatedBlock: string;
  lastExitBlock: string;
  /** null when verdictOf could not be read. */
  verdict: GateVerdict | null;
  /** registry.isCompliant(subjectChainId, vault, standardId); null when not read. */
  compliant: boolean | null;
  /** The registry's latest attestation; null when there is none or it could not be read (see errors). */
  attestation: GateAttestationJson | null;
  canExit: boolean;
}

export type GateEventJson = { blockNumber: string; txHash: string; logIndex: number } & (
  | { kind: 'Allocated'; vault: string; attestationId: string; assets: string; shares: string }
  | { kind: 'Exited'; vault: string; attestationId: string; caller: string; verdict: GateVerdict; path: GateExitPath; shares: string; assets: string }
  | { kind: 'ExitFailed'; vault: string; attestationId: string; caller: string; verdict: GateVerdict; shares: string; redeemError: string; withdrawError: string }
  | { kind: 'IdleWithdrawn'; to: string; amount: string }
  | { kind: 'Resynced'; vault: string; fromShares: string; toShares: string }
);

export interface GateViewJson {
  address: string;
  chainId: number;
  registry: string;
  asset: string;
  assetSymbol: string | null;
  assetDecimals: number;
  owner: string;
  subjectChainId: string;
  standardId: string;
  /** The suite the gate pins; all zeros accepts any. */
  suiteHash: string;
  /** Gas each vault call and each vault read of an exit gets. */
  vaultCallGas: string;
  vaultViewGas: string;
  maxAttestationAge: string;
  idle: string;
  /** Head block and its timestamp (unix seconds) when the page was read. */
  head: string;
  now: string;
  vaults: GateVaultJson[];
  /** Newest first: the blocks of each vault's last allocation and exit attempt, and the latest RECENT_LOG_BLOCKS blocks. */
  events: GateEventJson[];
  /** Reads that failed; the page lists them instead of showing guesses. */
  errors: string[];
}

export type GatePageJson = { deployed: false } | { deployed: true; address: string; view: GateViewJson | null; error: string | null };
