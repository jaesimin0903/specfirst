import { z } from 'zod';
import { REASON_CODES } from './decide.js';
import { ACTIONS, type Action } from './verdict.js';

/*
 * Input and output schemas of the four tools. The output schemas are what tools/list advertises and what the SDK
 * holds every structured result to; test/server.e2e.test.ts calls each tool through a real client.
 */

const actionEnum = z.enum(ACTIONS as [Action, ...Action[]]);
const address = z
  .string()
  .describe('Vault address, 0x and 40 hex digits. Lower case, upper case or a valid EIP-55 checksum; a mixed-case address with a wrong checksum is refused.');
const chainId = z.number().int().positive().default(143).describe('Chain of the vault. 143 is Monad mainnet, the chain the board and the watcher cover.');

export const verdictInput = z.object({ address, chainId });
export const moveInput = z.object({
  address,
  chainId,
  action: actionEnum.describe('What you are about to do: deposit or mint puts money in, withdraw or redeem takes it out.'),
  amount: z
    .string()
    .regex(/^\d+$/, 'an integer in base units, such as "1000000" for 1 USDC')
    .max(78)
    .optional()
    .describe('Optional. Base units of the asset for deposit and withdraw, of shares for mint and redeem. Echoed back; the decision does not depend on it.'),
});
export const findingsInput = z.object({
  chainId: z.number().int().positive().default(143).describe('Chain whose watcher feed to read. 143 is Monad mainnet; 10143 is the testnet demo watcher.'),
  limit: z.number().int().min(1).max(50).default(10).describe('At most this many changes and this many current mismatches (1 to 50).'),
});
export const watchInput = z.object({ address, chainId });

const counts = z.object({ pass: z.number(), fail: z.number(), inconclusive: z.number(), notApplicable: z.number() });
const links = z.object({ page: z.string(), requestCheck: z.string(), inbox: z.string() });

const call = z.object({
  kind: z.enum(['max-honored', 'fuzz-counterexample']),
  text: z.string(),
  function: actionEnum.optional(),
  argument: z.string().optional(),
  maxFunction: z.string().optional(),
  maxValue: z.string().optional(),
  revertSelector: z.string().nullable().optional(),
  revertError: z.string().nullable().optional(),
  test: z.string().optional(),
  calls: z.array(z.string()).optional(),
});

const attestation = z.object({
  read: z.enum(['ok', 'none', 'unread']),
  reason: z.string().nullable(),
  registry: z.object({ chainId: z.number(), address: z.string() }),
  rpc: z.string(),
  id: z.string().nullable(),
  status: z.string().nullable(),
  isCompliant: z.boolean().nullable(),
  issuedAt: z.string().nullable(),
  ageHours: z.number().nullable(),
  blockNumber: z.string().nullable(),
  issuer: z.string().nullable(),
  issuerCurrent: z.boolean().nullable(),
  reportHash: z.string().nullable(),
  reportURI: z.string().nullable(),
  counts: counts.nullable(),
  failedProperties: z.array(z.string()),
  failedLevel: z.enum(['must', 'should', 'none']).nullable(),
  matchesReport: z.boolean().nullable(),
  sameImplementationAsReport: z.boolean().nullable(),
  relativeToReport: z.enum(['same-block', 'earlier-block', 'later-block']).nullable(),
  txUrl: z.string().nullable(),
  serverAgrees: z.boolean().nullable(),
});

const verdictStatus = z.enum(['all-passed', 'mismatch', 'partly-checked', 'not-applicable', 'unchecked', 'unknown']);
const vaultLevel = z.enum(['must', 'rounding', 'should', 'none']).nullable();

export const verdictOutput = z.object({
  vault: z.object({ address: z.string(), chainId: z.number(), name: z.string().nullable(), protocol: z.string().nullable(), assetSymbol: z.string().nullable() }),
  status: verdictStatus,
  level: vaultLevel,
  basis: z.enum(['report', 'attestation', 'none']),
  summary: counts.extend({ total: z.number() }).nullable(),
  blockChecked: z.string().nullable(),
  checkedAt: z.string().nullable(),
  failed: z.array(
    z.object({
      id: z.string(),
      level: z.enum(['must', 'should']),
      topic: z.enum(['must', 'allowance', 'rounding', 'round-trip']),
      eip: z.string().nullable(),
      explanation: z.string(),
      call: call.nullable(),
      concerns: z.array(actionEnum),
    }),
  ),
  notJudged: z.array(z.object({ id: z.string(), status: z.enum(['inconclusive', 'not_applicable']), reason: z.string() })),
  traits: z.array(z.object({ id: z.string(), label: z.string(), basis: z.string() })),
  report: z
    .object({
      url: z.string().nullable(),
      reportHash: z.string(),
      verified: z.boolean().nullable(),
      matchesApiSummary: z.boolean().nullable(),
      coversAllProperties: z.boolean().nullable(),
      fullStrength: z.boolean().nullable(),
      reproduce: z.string().nullable(),
    })
    .nullable(),
  attestation,
  freshness: z.object({ reportAgeHours: z.number().nullable(), staleAfterHours: z.number(), stale: z.boolean().nullable(), attestationAgeHours: z.number().nullable() }),
  watcher: z
    .object({ knows: z.boolean(), foundBy: z.string().nullable(), foundAt: z.string().nullable(), lastCheckBlock: z.string().nullable(), lastCheckAt: z.string().nullable() })
    .nullable(),
  links,
  problems: z.array(z.string()),
  meaning: z.array(z.string()),
  readAt: z.string(),
});

export const moveOutput = z.object({
  decision: z.enum(['refuse', 'caution', 'proceed']),
  action: actionEnum,
  amount: z.string().nullable(),
  vault: z.object({ address: z.string(), chainId: z.number(), name: z.string().nullable(), protocol: z.string().nullable() }),
  summary: z.string(),
  reasons: z.array(z.object({ code: z.enum(REASON_CODES), effect: z.enum(['refuse', 'caution', 'info']), text: z.string() })),
  sizing: z.array(z.string()),
  basis: z.object({
    status: verdictStatus,
    level: vaultLevel,
    blockChecked: z.string().nullable(),
    checkedAt: z.string().nullable(),
    reportAgeHours: z.number().nullable(),
    attestationId: z.string().nullable(),
    attestationCompliant: z.boolean().nullable(),
    attestationBlock: z.string().nullable(),
  }),
  meaning: z.array(z.string()),
  links,
  decidedAt: z.string(),
});

const findingVault = z.object({ address: z.string(), name: z.string().nullable(), protocol: z.string().nullable(), page: z.string() });
const outcome = z.object({ status: z.string(), level: z.enum(['must', 'rounding', 'should']).nullable(), failed: z.array(z.string()), summary: counts });

export const findingsOutput = z.object({
  chainId: z.number(),
  watcher: z
    .object({
      running: z.boolean(),
      stale: z.boolean(),
      problem: z.string().nullable(),
      head: z.string().nullable(),
      behindBlocks: z.number().nullable(),
      updatedAt: z.string().nullable(),
      checked24h: z.number().nullable(),
      changed24h: z.number().nullable(),
      attested24h: z.number().nullable(),
    })
    .nullable(),
  changes: z.array(
    z.object({
      seq: z.number(),
      at: z.string(),
      kind: z.string(),
      vault: findingVault,
      text: z.string(),
      from: outcome.nullable(),
      to: outcome.nullable(),
      priceDrop: z.object({ fromAssetsPerShare: z.string(), toAssetsPerShare: z.string(), dropBps: z.number(), fromBlock: z.string(), toBlock: z.string() }).nullable(),
      block: z.string().nullable(),
      attestation: z.object({ id: z.string(), txUrl: z.string().nullable() }).nullable(),
      reportUrl: z.string().nullable(),
    }),
  ),
  currentMismatches: z.array(
    z.object({
      vault: findingVault,
      block: z.string(),
      at: z.string(),
      level: z.enum(['must', 'rounding', 'should']).nullable(),
      failed: z.array(z.string()),
      pending: z.boolean(),
      reportUrl: z.string().nullable(),
    }),
  ),
  scanned: z.object({ events: z.number(), oldestSeq: z.number().nullable(), oldestAt: z.string().nullable(), latestSeq: z.number().nullable(), reachedStart: z.boolean() }),
  links: z.object({ feed: z.string() }),
  problems: z.array(z.string()),
  meaning: z.array(z.string()),
  readAt: z.string(),
});

export const watchOutput = z.object({
  vault: z.object({ address: z.string(), chainId: z.number() }),
  subscriptions: z.object({
    contract: z.string(),
    chainId: z.number(),
    explorer: z.string(),
    feePerDayWei: z.string().nullable(),
    feePerDayMon: z.string().nullable(),
    fee: z.enum(['chain', 'unread']),
    reason: z.string().nullable(),
    call: z.string(),
    args: z.object({ subjectChainId: z.number(), subject: z.string(), standardId: z.string(), days: z.string() }),
    value: z.string(),
    accounting: z.string(),
    cadence: z.string(),
  }),
  web: z.object({ vaultPage: z.string(), inbox: z.string(), feed: z.string() }),
  webhook: z.object({
    register: z.string(),
    message: z.string(),
    rules: z.string(),
    payloadFields: z.array(z.string()),
    kinds: z.array(z.object({ kind: z.string(), when: z.string() })),
    idempotencyKey: z.string(),
    delivery: z.string(),
  }),
  watcher: z
    .object({ knows: z.boolean(), foundBy: z.string().nullable(), lastCheckBlock: z.string().nullable(), lastCheckAt: z.string().nullable(), lastAttestationId: z.string().nullable() })
    .nullable(),
  notes: z.array(z.string()),
  readAt: z.string(),
});
