import { encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { canonicalJson } from '../spec/hash.js';
import { ERC4626_CHECK_PROPERTIES, type StandardProperty } from '../standards/erc4626.js';
import { standardCheckReportSchema, type StandardCheckReport, type StandardName } from '../standards/report.js';

/** Most results one attestation can carry: one bit each in a uint256 bitmap. */
export const MAX_ATTESTED_RESULTS = 256;
/** CheckAttestationRegistry.MAX_REPORT_URI_LENGTH: longest reportURI, in UTF-8 bytes. */
export const MAX_REPORT_URI_BYTES = 512;
const MAX_UINT64 = 2n ** 64n - 1n;

/**
 * The property table of each standard, in report order: result i of a report is property i, so bit i of the
 * attestation bitmaps means this property. Suite.propertiesHash commits to it.
 */
export const STANDARD_PROPERTIES: Readonly<Record<StandardName, readonly StandardProperty[]>> = {
  erc4626: ERC4626_CHECK_PROPERTIES,
};

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
  /** Report toolchain.forgeVersion, the first line of `forge --version`; "" when forge did not run. */
  forgeVersion: string;
  harnessSha256: Hex;
  sfPropertiesSha256: Hex;
  /** propertiesHash of the report's results: which property each bit of the bitmaps stands for. */
  propertiesHash: Hex;
  foundryTomlSha256: Hex;
  runs: bigint;
  maxTestRejects: bigint;
  delta: bigint;
}

/** Same field order as CheckAttestationRegistry.AttestParams. */
export interface AttestParams {
  subjectChainId: bigint;
  subject: Address;
  standardId: Hex;
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
      { name: 'forgeVersion', type: 'string' },
      { name: 'harnessSha256', type: 'bytes32' },
      { name: 'sfPropertiesSha256', type: 'bytes32' },
      { name: 'propertiesHash', type: 'bytes32' },
      { name: 'foundryTomlSha256', type: 'bytes32' },
      { name: 'runs', type: 'uint256' },
      { name: 'maxTestRejects', type: 'uint256' },
      { name: 'delta', type: 'uint256' },
    ],
  },
] as const;

/** standardId = keccak256(bytes(standard)), e.g. keccak256("erc4626"). The registry keys attestations by it. */
export function standardIdOf(standard: string): Hex {
  return keccak256(toHex(standard));
}

/**
 * propertiesHash = keccak256 of the UTF-8 canonical JSON of [{id, test, description}, ...] in order. For a
 * report it is taken over its results; cert attest only accepts reports whose list is the standard's table
 * (STANDARD_PROPERTIES), so the value is the table's hash and bit i always names the same property.
 */
export function propertiesHash(properties: ReadonlyArray<Pick<StandardProperty, 'id' | 'test' | 'description'>>): Hex {
  return keccak256(toHex(canonicalJson(properties.map(({ id, test, description }) => ({ id, test, description })))));
}

/** The suite fields of a check report. Git commits (40 hex) become bytes20. */
export function suiteOf(report: StandardCheckReport): AttestationSuite {
  return {
    standard: report.standard,
    upstreamRepo: report.upstream.repo,
    upstreamCommit: `0x${report.upstream.commit}`,
    forgeStdCommit: `0x${report.toolchain.forgeStd.commit}`,
    forgeVersion: report.toolchain.forgeVersion ?? '',
    harnessSha256: report.harnessSha256 as Hex,
    sfPropertiesSha256: report.sfPropertiesSha256 as Hex,
    propertiesHash: propertiesHash(report.results),
    foundryTomlSha256: report.toolchain.foundryTomlSha256 as Hex,
    runs: BigInt(report.runs),
    maxTestRejects: BigInt(report.toolchain.maxTestRejects),
    delta: BigInt(report.delta),
  };
}

/**
 * suiteHash = keccak256(abi.encode(Suite)), the Suite struct encoded as one ABI tuple:
 * (string standard, string upstreamRepo, bytes20 upstreamCommit, bytes20 forgeStdCommit, string forgeVersion,
 *  bytes32 harnessSha256, bytes32 sfPropertiesSha256, bytes32 propertiesHash, bytes32 foundryTomlSha256,
 *  uint256 runs, uint256 maxTestRejects, uint256 delta).
 * CheckAttestationRegistry.suiteHashOf computes the same value onchain.
 */
export function suiteHash(suite: AttestationSuite): Hex {
  return keccak256(encodeAbiParameters(suiteTuple, [suite]));
}

/**
 * reportHash = keccak256 of the UTF-8 bytes of the report's canonical JSON (canonicalJson in spec/hash.ts):
 * RFC 8785 (JCS) for the values a report holds, i.e. keys sorted by UTF-16 code units, no whitespace, strings
 * escaped as JSON.stringify does (non-ASCII written as UTF-8, not \u escapes) and integers in plain decimal.
 * Formatting and key order of the file on disk do not change it; any value does.
 */
export function checkReportHash(report: StandardCheckReport): Hex {
  return keccak256(toHex(canonicalJson(report)));
}

/**
 * Where a report is kept, relative to the certs/checks directory and to --report-base-url:
 * `<chainId>/<address lowercase>/<block>-<first 8 bytes of reportHash, 16 hex>.json`. Two different reports of
 * one block never share a file.
 */
export function attestationReportPath(report: StandardCheckReport, reportHash: Hex = checkReportHash(report)): string {
  return `${report.chainId}/${report.address.toLowerCase()}/${report.blockNumber}-${reportHash.slice(2, 18)}.json`;
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
 * CheckAttestationRegistry.attest parameters for a validated report. Pure: the subject's code hash and
 * implementation key are the report's identity (verifySubjectCode checks the identity against the subject
 * chain before issuing). Refuses a report whose results are not the standard's property table in order, so
 * bit i of an attestation always means the same property, and a reportURI the registry would reject.
 */
export function attestationParamsFromReport(report: StandardCheckReport, opts: { reportURI: string }): AttestParams {
  const blockNumber = BigInt(report.blockNumber);
  if (blockNumber > MAX_UINT64) throw new AttestationError(`blockNumber ${blockNumber} does not fit uint64`);
  const table = STANDARD_PROPERTIES[report.standard];
  const suite = suiteOf(report);
  if (suite.propertiesHash !== propertiesHash(table)) {
    throw new AttestationError(
      `the report's ${report.results.length} results are not the ${report.standard} property table (${table.length} properties, same ids, tests and descriptions, same order); bit i of an attestation would not mean property i`,
    );
  }
  const uriBytes = new TextEncoder().encode(opts.reportURI).length;
  if (uriBytes > MAX_REPORT_URI_BYTES) throw new AttestationError(`reportURI is ${uriBytes} bytes; the registry accepts at most ${MAX_REPORT_URI_BYTES}`);
  const passedBitmap = statusBitmap(report, 'pass');
  const failedBitmap = statusBitmap(report, 'fail');
  return {
    subjectChainId: BigInt(report.chainId),
    subject: getAddress(report.address),
    standardId: standardIdOf(report.standard),
    blockNumber,
    implementationKey: report.identity.implementationKey as Hex,
    subjectCodeHash: report.identity.codeHash as Hex,
    suiteHash: suiteHash(suite),
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
