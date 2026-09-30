#!/usr/bin/env node
// Builds the Monad ERC-4626 board data from check reports:
//   data/board.json, data/vaults/<chainId>/<address>.json, public/reports/<chainId>/<address>/<file>.json
//
//   pnpm --filter @specfirst/web board:build [-- --source <dir>] [-- --offline] [-- --if-missing]
//
// Reports: <source>/<chainId>/<address>/*.json (StandardCheckReport; *.forge.json is ignored). The source is
// --source, else $SPECFIRST_BOARD_SOURCE, else <repo>/certs/checks. A relative path resolves against the
// repository root. A missing source directory gives an empty board, not an error.
// Metadata: data/vault-meta.json (scripts/build-vault-meta.mjs). Transaction hashes: data/attestation-txs.json.
// Registry: CheckAttestationRegistry on Monad testnet, read with eth_call only ($SPECFIRST_BOARD_REGISTRY,
// $SPECFIRST_BOARD_RPC). --offline or SPECFIRST_BOARD_OFFLINE=1 skips it; a failed read never fails the build.
// --if-missing does nothing when data/board.json already exists (used by `build` and `dev`).
//
// The pipeline itself is TypeScript (lib/board/pipeline.ts), loaded with Node's built-in type stripping.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..');
const repoRoot = path.join(webRoot, '..', '..');
const dataDir = path.join(webRoot, 'data');

function parseArgs(argv) {
  const out = { source: undefined, offline: false, ifMissing: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    else if (a === '--source') out.source = argv[++i];
    else if (a.startsWith('--source=')) out.source = a.slice('--source='.length);
    else if (a === '--offline') out.offline = true;
    else if (a === '--if-missing') out.ifMissing = true;
    else {
      console.error(`board:build: unknown argument ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function sourceLabel(dir) {
  const rel = path.relative(repoRoot, dir);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return `.../${dir.split(path.sep).filter(Boolean).slice(-2).join('/')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.ifMissing && existsSync(path.join(dataDir, 'board.json'))) {
    console.log('board:build: data/board.json exists, kept it (run `pnpm --filter @specfirst/web board:build` to rebuild)');
    return;
  }
  if (!process.features?.typescript) {
    console.error('board:build: this Node has no built-in TypeScript type stripping. Use Node 22.18+ (or 23.6+).');
    process.exit(1);
  }

  const { buildBoard, readVaultMeta, readAttestationTxs } = await import('../lib/board/pipeline.ts');
  const { DEFAULT_ATTESTATION_REGISTRY, DEFAULT_ATTESTATION_RPC, ATTESTATION_CHAIN_ID, ERC4626_STANDARD_ID } = await import(
    '../lib/board/attestations.ts'
  );
  const core = await import('@specfirst/core');
  if (core.standardIdOf('erc4626').toLowerCase() !== ERC4626_STANDARD_ID) {
    console.error('board:build: ERC4626_STANDARD_ID does not match @specfirst/core standardIdOf("erc4626")');
    process.exit(1);
  }

  const rawSource = args.source ?? process.env.SPECFIRST_BOARD_SOURCE ?? 'certs/checks';
  const sourceDir = path.resolve(repoRoot, rawSource);
  const registry = {
    chainId: ATTESTATION_CHAIN_ID,
    address: process.env.SPECFIRST_BOARD_REGISTRY || DEFAULT_ATTESTATION_REGISTRY,
    rpc: process.env.SPECFIRST_BOARD_RPC || DEFAULT_ATTESTATION_RPC,
  };
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry.address)) {
    console.error(`board:build: SPECFIRST_BOARD_REGISTRY is not an address: ${registry.address}`);
    process.exit(2);
  }
  const offline = args.offline || process.env.SPECFIRST_BOARD_OFFLINE === '1';
  let client = null;
  if (!offline) {
    const { createPublicClient, http } = await import('viem');
    client = createPublicClient({ transport: http(registry.rpc, { timeout: 10_000, retryCount: 1 }) });
  }

  const meta = await readVaultMeta(path.join(dataDir, 'vault-meta.json'));
  const txHashes = await readAttestationTxs(path.join(dataDir, 'attestation-txs.json'), registry.chainId, registry.address);
  const result = await buildBoard({
    sourceDir,
    sourceLabel: sourceLabel(sourceDir),
    dataDir,
    publicDir: path.join(webRoot, 'public'),
    meta,
    registry: { ...registry, rpc: registry.rpc.replace(/^(https?:\/\/[^/]+).*$/, '$1') },
    client,
    skippedBecause: offline ? 'registry reading switched off (--offline)' : undefined,
    abi: core.checkAttestationRegistryAbi,
    standardId: ERC4626_STANDARD_ID,
    txHashes,
  });

  const b = result.board;
  const t = b.totals;
  if (!result.sourceExists) console.log(`board:build: ${sourceLabel(sourceDir)} does not exist, wrote an empty board`);
  console.log(
    `board:build: ${t.vaults} vaults, ${t.implementations} implementations: ${t.complete} all passed, ${t.mismatch} mismatch (${t.mismatchImplementations} implementations), ${t.partial} partly checked, ${t.notApplicable} not applicable; ${t.unchecked} in vault-meta without a report`,
  );
  const r = b.registry;
  console.log(
    `board:build: registry ${r.address} on ${r.chainId}: ${r.status}${r.status === 'ok' ? `, ${r.attestationCount} attestations, ${t.attested} board vaults attested` : `, ${r.error}`}`,
  );
  if (b.skipped.length) {
    console.log(`board:build: skipped ${b.skipped.length} files:`);
    for (const s of b.skipped.slice(0, 10)) console.log(`  ${s.file}: ${s.error}`);
  }
  console.log(`board:build: wrote data/board.json, data/vaults/ (${result.details.length}), public/reports/ from ${b.source}`);
}

main().catch((err) => {
  console.error(`board:build: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
