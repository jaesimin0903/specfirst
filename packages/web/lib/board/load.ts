import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { BoardData, RegistryRead, VaultDetail } from './types';
import { emptyBoard } from './aggregate.ts';
import { ATTESTATION_CHAIN_ID, DEFAULT_ATTESTATION_REGISTRY, DEFAULT_ATTESTATION_RPC } from './attestations.ts';

/*
 * Server-side reads of the files scripts/build-board.mjs writes. The board pages are prerendered, so this runs
 * at build time; a missing board.json renders the empty state instead of failing the build.
 */

export function boardDataDir(): string {
  return process.env.SPECFIRST_BOARD_DATA ?? path.join(process.cwd(), 'data');
}

const NOT_BUILT: RegistryRead = {
  chainId: ATTESTATION_CHAIN_ID,
  address: DEFAULT_ATTESTATION_REGISTRY,
  rpc: DEFAULT_ATTESTATION_RPC,
  status: 'skipped',
  error: 'board data not built',
  attestationCount: null,
  readAt: null,
};

export function loadBoard(dir: string = boardDataDir()): BoardData {
  try {
    const board = JSON.parse(readFileSync(path.join(dir, 'board.json'), 'utf8')) as BoardData;
    if (board?.version !== 1 || !Array.isArray(board.vaults)) throw new Error('unexpected board.json');
    // Fields added after the first board files were written; an older file still renders.
    return {
      ...board,
      vaults: board.vaults.map((v) => ({ ...v, traits: v.traits ?? [] })),
      runs: board.runs ?? [],
      skipped: board.skipped ?? [],
      reasons: board.reasons ?? [],
    };
  } catch {
    return emptyBoard(NOT_BUILT, new Date(0).toISOString(), 'none');
  }
}

const CHAIN_RE = /^\d{1,12}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** null for anything that is not a built vault; params are checked before they touch the file system. */
export function loadVaultDetail(chainId: string, address: string, dir: string = boardDataDir()): VaultDetail | null {
  const addr = address.toLowerCase();
  if (!CHAIN_RE.test(chainId) || !ADDRESS_RE.test(addr)) return null;
  try {
    return JSON.parse(readFileSync(path.join(dir, 'vaults', chainId, `${addr}.json`), 'utf8')) as VaultDetail;
  } catch {
    return null;
  }
}
