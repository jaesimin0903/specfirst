import type { FailedProperty, StatusCounts, VaultStatus } from '../board/types';
import type { RequestStatusName, WorkerStage } from './contract';
import type { Progress } from './stages';

/*
 * JSON the desk API routes return and the client components read. Wei amounts and ids are decimal strings.
 * Client-safe: types only.
 */

export interface DeskConfigJson {
  /** null: NEXT_PUBLIC_SPECFIRST_DESK_10143 is unset, the desk is not deployed. */
  address: string | null;
  chainId: number;
  subjectChainId: number;
  standardId: string;
}

export interface DeskSummaryJson {
  deployed: boolean;
  address: string | null;
  chainId: number;
  feeWei: string | null;
  timeoutSec: string | null;
  requestCount: string | null;
  earnedWei: string | null;
  withdrawnWei: string | null;
  escrowedWei: string | null;
  owner: string | null;
  worker: string | null;
  registry: string | null;
  /** Reads that failed; the page says so instead of showing zeros. */
  errors: string[];
  readAt: string;
}

export interface RequestJson {
  id: string;
  requester: string;
  subjectChainId: number;
  subject: string;
  standardId: string;
  feeWei: string;
  requestedAt: string;
  status: RequestStatusName;
  attestationId: string;
  rejectReason: string;
}

export interface VaultLabelJson {
  name: string | null;
  protocol: string | null;
  assetSymbol: string | null;
}

export interface RecentRequestJson {
  request: RequestJson;
  vault: VaultLabelJson;
  stage: WorkerStage | null;
  /** One word for lists: Queued, Running, Fulfilled, Rejected, Refunded, Expired... */
  label: string;
  tone: 'active' | 'done' | 'ended';
}

export interface ResultJson {
  vaultPath: string;
  status: VaultStatus;
  summary: StatusCounts;
  total: number;
  cells: string;
  split: number;
  /**
   * topic, delta and amount: the failure's class (lib/board/levels), as on the board; only when the report is the one
   * the registry's attestation, the desk worker or the board names. Without them the ids alone give a level.
   */
  failed: ({ id: string; finding: string; rule: string | null } & Pick<FailedProperty, 'topic' | 'delta' | 'amount'>)[];
  blockNumber: string;
  startedAt: string;
  reportHash: string;
  reportPath: string | null;
  attestation: {
    id: string;
    status: string;
    isCompliant: boolean | null;
    matchesReport: boolean;
    txHash: string | null;
  } | null;
  badgePath: string;
  apiPath: string;
  reproduce: string;
}

export interface RequestViewJson {
  desk: DeskConfigJson;
  request: RequestJson;
  vault: VaultLabelJson;
  worker: {
    available: boolean;
    problem: string | null;
    stage: WorkerStage | null;
    updatedAt: string | null;
    error: string | null;
    txs: { attest?: string; fulfill?: string; reject?: string };
    gasCostWei: string | null;
  };
  timeoutSec: string | null;
  progress: Progress;
  result: ResultJson | null;
  readAt: string;
}

export interface EconomicsJson {
  feeWei: string | null;
  earnedWei: string | null;
  withdrawnWei: string | null;
  escrowedWei: string | null;
  withdrawableWei: string | null;
  gasCostWei: string | null;
  netWei: string | null;
  marginPct: number | null;
  gasPerCheckWei: string | null;
  unitProfitWei: string | null;
  counts: {
    total: number;
    pending: number;
    fulfilled: number;
    rejected: number;
    refunded: number;
    expired: number;
    paidWei: string;
    returnedWei: string;
    truncated: boolean;
  } | null;
  summary: string;
}

export interface DeskViewJson {
  summary: DeskSummaryJson;
  economics: EconomicsJson;
  recent: RecentRequestJson[];
  worker: { available: boolean; problem: string | null; fulfilled: number | null; rejected: number | null };
}
