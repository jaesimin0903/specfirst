/**
 * Shape of the board data written by scripts/build-board.mjs (data/board.json and data/vaults/**) and read
 * by the board pages. Types only, so both the Node build script (run with type stripping) and the Next app
 * can import it without pulling in anything else.
 */

export type PropertyStatus = 'pass' | 'fail' | 'inconclusive' | 'not_applicable';

/**
 * One word per vault, from its latest report:
 * mismatch: at least one property failed.
 * complete: every property passed.
 * not_applicable: no property applied (nothing passed, failed or was inconclusive).
 * partial: nothing failed, but some properties were inconclusive or not applicable.
 */
export type VaultStatus = 'mismatch' | 'complete' | 'partial' | 'not_applicable';

/** Report-level `skipReason` (schemaVersion 3), or what an older report implies. */
export type SkipReason = 'native-asset' | 'separate-share-token' | 'asset-transfer-restricted' | 'missing-precompile' | 'setup-reverted';

/** Why a property was inconclusive or not applicable, grouped for people rather than for forge. */
export type ReasonCategory =
  | 'inputs-rejected'
  | 'max-zero'
  | 'unfundable-asset'
  | 'asset-transfer-restricted'
  | 'missing-precompile'
  | 'rpc-error'
  | 'separate-share-token'
  | 'native-asset'
  | 'setup-reverted'
  | 'other';

export interface StatusCounts {
  pass: number;
  fail: number;
  inconclusive: number;
  notApplicable: number;
}

export type VaultStatusCounts = Record<VaultStatus, number>;

export interface PropertyInfo {
  id: string;
  test: string;
  description: string;
  /** a16z/erc4626-tests, or Specfirst's own max-honored properties (ids starting with "sf-"). */
  origin: 'upstream' | 'specfirst';
}

export type AttestationStatusName = 'None' | 'Valid' | 'Superseded' | 'Revoked';

export interface AttestationRecord {
  id: string;
  status: AttestationStatusName;
  /** isCompliant(subjectChainId, subject, standardId) as the registry answered it; null when that read failed. */
  compliant: boolean | null;
  blockNumber: string;
  reportHash: string;
  suiteHash: string;
  implementationKey: string;
  subjectCodeHash: string;
  counts: StatusCounts;
  issuedAt: string;
  issuer: string;
  reportURI: string;
  /** From data/attestation-txs.json; the registry itself does not store it. */
  txHash: string | null;
}

/**
 * What the board knows about a vault's onchain attestation:
 * unread: the registry could not be read at build time (or reading was switched off).
 * none: the registry was read and holds no attestation for this vault and standard.
 * attested: the latest attestation, compared with the report shown on the board.
 */
export type AttestationView =
  | { kind: 'unread'; reason: string }
  | { kind: 'none' }
  | ({ kind: 'attested'; matchesReport: boolean; suiteMatches: boolean } & AttestationRecord);

/** What the vault table needs to show onchain state; AttestationView satisfies it. */
export type AttestationLite =
  | { kind: 'unread'; reason: string }
  | { kind: 'none' }
  | { kind: 'attested'; id: string; status: AttestationStatusName; matchesReport: boolean; blockNumber: string };

/**
 * A capability of the vault with its evidence (report `traits`, schemaVersion 4). Context only: a trait never
 * changes a status or the verdict. async-redeem: exits go through a request function (ERC-7540 style).
 */
export interface VaultTraitView {
  id: 'async-redeem';
  evidence: {
    codeAddress: string;
    requestFunctions: string[];
    erc165: { asyncRedeem: boolean; asyncDeposit: boolean; operator: boolean } | null;
    run: 'exits-rejected' | 'not-exercised';
  };
}

export interface FailedProperty {
  id: string;
  reason: string;
}

export interface VaultRow {
  /** `<chainId>/<address lowercase>`, also the vault page path under /v/. */
  id: string;
  chainId: number;
  /** As written in the report (checksummed). */
  address: string;
  name: string | null;
  protocol: string | null;
  assetSymbol: string | null;
  status: VaultStatus;
  vaultKind: 'erc4626' | 'erc7535' | 'erc7575' | null;
  skipReason: SkipReason | null;
  blockNumber: string;
  summary: StatusCounts;
  /** One character per result in report order: p pass, f fail, i inconclusive, n not applicable. */
  cells: string;
  implementationKey: string;
  implementationKeyKind: { of: 'implementation' | 'self'; hash: string };
  proxyKind: string | null;
  implementationAddress: string | null;
  /** Vaults on the board that share this implementationKey, this one included. */
  groupSize: number;
  failed: FailedProperty[];
  reasonCategories: ReasonCategory[];
  /** From the report (empty for reports before schemaVersion 4). */
  traits: VaultTraitView[];
  attestation: AttestationView;
  /** Public path of the report file this row was built from, e.g. /reports/143/0xabc.../109195820.json. */
  reportPath: string;
}

export interface ImplementationGroup {
  key: string;
  keyKind: { of: 'implementation' | 'self'; hash: string };
  /** Implementation contracts behind the proxies of this group (empty when the vaults are not proxies). */
  implementationAddresses: string[];
  vaultIds: string[];
  protocols: string[];
  statusCounts: VaultStatusCounts;
}

export interface ProtocolSummary {
  protocol: string;
  vaults: number;
  implementations: number;
  statusCounts: VaultStatusCounts;
}

export interface ReasonTally {
  category: ReasonCategory;
  /** Vaults with at least one property in this category. */
  vaults: number;
  /** Properties in this category, across all vaults. */
  properties: number;
}

export interface RegistryRead {
  chainId: number;
  address: string;
  rpc: string;
  status: 'ok' | 'error' | 'skipped';
  error: string | null;
  attestationCount: number | null;
  readAt: string | null;
}

export interface BoardTotals {
  vaults: number;
  implementations: number;
  complete: number;
  mismatch: number;
  /** Distinct implementationKeys among the mismatch vaults. */
  mismatchImplementations: number;
  partial: number;
  notApplicable: number;
  /** Vaults with an onchain attestation (any status). */
  attested: number;
  /** Vaults listed in the metadata file for the board's chains that have no report yet. */
  unchecked: number;
}

export interface BoardData {
  version: 1;
  generatedAt: string;
  /** Where the reports came from, as given to the build (relative to the repository when inside it). */
  source: string;
  standard: 'erc4626';
  blocks: { chainId: number; blockNumber: string; vaults: number }[];
  /** Distinct fuzz run counts across the latest reports, ascending. */
  runs: number[];
  properties: PropertyInfo[];
  totals: BoardTotals;
  propertyTotals: StatusCounts;
  reasons: ReasonTally[];
  protocols: ProtocolSummary[];
  groups: ImplementationGroup[];
  vaults: VaultRow[];
  registry: RegistryRead;
  /** Files under the source directory that were not valid reports, with why. */
  skipped: { file: string; error: string }[];
}

export interface CounterexampleView {
  calls: string[];
  calldata?: string;
  logs: string[];
}

export interface ReportResultView {
  id: string;
  test: string;
  description: string;
  status: PropertyStatus;
  runs?: number;
  reason?: string;
  counterexample?: CounterexampleView;
}

/** The fields of a StandardCheckReport the vault page shows. The full report is served as-is from /reports. */
export interface ReportView {
  schemaVersion: number;
  chainId: number;
  address: string;
  blockNumber: string;
  standard: string;
  vaultKind?: 'erc4626' | 'erc7535' | 'erc7575';
  skipReason?: SkipReason | null;
  traits?: VaultTraitView[];
  upstream: { repo: string; commit: string };
  harnessSha256: string;
  sfPropertiesSha256: string;
  runs: number;
  delta: string;
  seed: string | null;
  sender: string | null;
  toolchain: {
    forgeVersion: string | null;
    forgeStd: { repo: string; commit: string };
    foundryTomlSha256: string;
    maxTestRejects: number;
  };
  identity: {
    codeHash: string;
    metadataHash: string | null;
    maskedCodeHash: string | null;
    codeSize: number;
    proxy: { kind: string; implementation?: string; beacon?: string } | null;
    implementation: { address: string; codeHash: string; metadataHash: string | null; maskedCodeHash: string | null } | null;
    implementationKey: string;
    implementationKeyKind: { of: 'implementation' | 'self'; hash: string };
  };
  results: ReportResultView[];
  summary: StatusCounts;
  startedAt: string;
  durationMs: number;
}

export interface SiblingVault {
  id: string;
  address: string;
  name: string | null;
  protocol: string | null;
  status: VaultStatus;
}

/** data/vaults/<chainId>/<address lowercase>.json */
export interface VaultDetail {
  row: VaultRow;
  report: ReportView;
  /** keccak256 of the report's canonical JSON, as `cert attest` records it. */
  reportHash: string;
  suiteHash: string;
  /** Other vaults on the board with the same implementationKey. */
  siblings: SiblingVault[];
  registry: RegistryRead;
}
