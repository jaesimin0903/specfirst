import { encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { canonicalJson } from '../spec/hash.js';
import { standardCheckReportSchema, type StandardCheckReport } from '../standards/report.js';

/** Most results one attestation can carry: one bit each in a uint256 bitmap. */
export const MAX_ATTESTED_RESULTS = 256;
const MAX_UINT64 = 2n ** 64n - 1n;

export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttestationError';
  }
}

/** What ran, as CheckAttestationRegistry.Suite. Field order is the ABI tuple order. */
export interface AttestationSuite {
  standard: string;
  upstreamRepo: string;
  upstreamCommit: Hex;
  forgeStdCommit: Hex;
  harnessSha256: Hex;
  sfPropertiesSha256: Hex;
  foundryTomlSha256: Hex;
  runs: bigint;
  maxTestRejects: bigint;
  delta: bigint;
}

/** Same field order as CheckAttestationRegistry.AttestParams. */
export interface AttestParams {
  subjectChainId: bigint;
  subject: Address;
  blockNumber: bigint;
  implementationKey: Hex;
  subjectCodeHash: Hex;
  suiteHash: Hex;
  reportHash: Hex;
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
  notApplicableCount: number;
  passedBitmap: bigint;
  failedBitmap: bigint;
  reportURI: string;
}

const suiteTuple = [
  {
    type: 'tuple',
    components: [
      { name: 'standard', type: 'string' },
      { name: 'upstreamRepo', type: 'string' },
      { name: 'upstreamCommit', type: 'bytes20' },
      { name: 'forgeStdCommit', type: 'bytes20' },
      { name: 'harnessSha256', type: 'bytes32' },
      { name: 'sfPropertiesSha256', type: 'bytes32' },
      { name: 'foundryTomlSha256', type: 'bytes32' },
      { name: 'runs', type: 'uint256' },
      { name: 'maxTestRejects', type: 'uint256' },
      { name: 'delta', type: 'uint256' },
    ],
  },
] as const;

/** The suite fields of a check report. Git commits (40 hex) become bytes20. */
export function suiteOf(report: StandardCheckReport): AttestationSuite {
  return {
    standard: report.standard,
    upstreamRepo: report.upstream.repo,
    upstreamCommit: `0x${report.upstream.commit}`,
    forgeStdCommit: `0x${report.toolchain.forgeStd.commit}`,
    harnessSha256: report.harnessSha256 as Hex,
    sfPropertiesSha256: report.sfPropertiesSha256 as Hex,
    foundryTomlSha256: report.toolchain.foundryTomlSha256 as Hex,
    runs: BigInt(report.runs),
    maxTestRejects: BigInt(report.toolchain.maxTestRejects),
    delta: BigInt(report.delta),
  };
}

/**
 * suiteHash = keccak256(abi.encode(Suite)), the Suite struct encoded as one ABI tuple:
 * (string standard, string upstreamRepo, bytes20 upstreamCommit, bytes20 forgeStdCommit,
 *  bytes32 harnessSha256, bytes32 sfPropertiesSha256, bytes32 foundryTomlSha256,
 *  uint256 runs, uint256 maxTestRejects, uint256 delta).
 * CheckAttestationRegistry.suiteHashOf computes the same value onchain.
 */
export function suiteHash(suite: AttestationSuite): Hex {
  return keccak256(encodeAbiParameters(suiteTuple, [suite]));
}

/**
 * reportHash = keccak256 of the UTF-8 bytes of the report's canonical JSON: keys sorted recursively,
 * no whitespace, undefined values dropped (canonicalJson in spec/hash.ts). Formatting and key order of the
 * file on disk do not change it; any value does.
 */
export function checkReportHash(report: StandardCheckReport): Hex {
  return keccak256(toHex(canonicalJson(report)));
}

/** Parses and validates a check report file. Throws AttestationError with the zod issues. */
export function parseCheckReport(text: string): StandardCheckReport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AttestationError('report is not JSON');
  }
  const parsed = standardCheckReportSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new AttestationError(`report is not a valid StandardCheckReport: ${issues.join('; ')}`);
  }
  return parsed.data;
}

/** Bit i set when results[i] has `status`. Order is the report's result order. */
export function statusBitmap(report: StandardCheckReport, status: 'pass' | 'fail'): bigint {
  if (report.results.length > MAX_ATTESTED_RESULTS) {
    throw new AttestationError(`report has ${report.results.length} results; an attestation holds at most ${MAX_ATTESTED_RESULTS}`);
  }
  let bits = 0n;
  report.results.forEach((r, i) => {
    if (r.status === status) bits |= 1n << BigInt(i);
  });
  return bits;
}

/**
 * CheckAttestationRegistry.attest parameters for a validated report. Pure: the subject's code hash is the
 * report's identity.codeHash (verifySubjectCode checks it against the subject chain before issuing).
 */
export function attestationParamsFromReport(report: StandardCheckReport, opts: { reportURI: string }): AttestParams {
  const blockNumber = BigInt(report.blockNumber);
  if (blockNumber > MAX_UINT64) throw new AttestationError(`blockNumber ${blockNumber} does not fit uint64`);
  const passedBitmap = statusBitmap(report, 'pass');
  const failedBitmap = statusBitmap(report, 'fail');
  return {
    subjectChainId: BigInt(report.chainId),
    subject: getAddress(report.address),
    blockNumber,
    implementationKey: report.identity.implementationKey as Hex,
    subjectCodeHash: report.identity.codeHash as Hex,
    suiteHash: suiteHash(suiteOf(report)),
    reportHash: checkReportHash(report),
    passCount: report.summary.pass,
    failCount: report.summary.fail,
    inconclusiveCount: report.summary.inconclusive,
    notApplicableCount: report.summary.notApplicable,
    passedBitmap,
    failedBitmap,
    reportURI: opts.reportURI,
  };
}
