import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import type { StandardCheckReport } from '../standards/report.js';
import { AttestationError } from './params.js';

/** The slice of a read-only client on the subject chain that verification needs. */
export type SubjectClient = Pick<PublicClient, 'getChainId' | 'getCode'>;

export interface SubjectCodeCheck {
  chainId: number;
  blockNumber: bigint;
  codeHash: Hex;
}

/**
 * Before an attestation is issued: the subject RPC serves the report's chain, and keccak256 of the
 * subject's runtime code at the report's block equals the report's identity.codeHash. The registry cannot
 * read another chain, so this is the issuer's own check of the value it will report. Read only.
 */
export async function verifySubjectCode(client: SubjectClient, report: StandardCheckReport): Promise<SubjectCodeCheck> {
  const chainId = await client.getChainId();
  if (chainId !== report.chainId) {
    throw new AttestationError(`subject RPC serves chain ${chainId}, the report is for chain ${report.chainId}`);
  }
  const blockNumber = BigInt(report.blockNumber);
  const code = (await client.getCode({ address: report.address as Address, blockNumber })) ?? '0x';
  if (code === '0x') throw new AttestationError(`no code at ${report.address} on chain ${chainId} block ${blockNumber}`);
  const codeHash = keccak256(code);
  if (codeHash !== report.identity.codeHash.toLowerCase()) {
    throw new AttestationError(
      `code at ${report.address} on chain ${chainId} block ${blockNumber} hashes to ${codeHash}, the report says ${report.identity.codeHash}`,
    );
  }
  return { chainId, blockNumber, codeHash };
}
