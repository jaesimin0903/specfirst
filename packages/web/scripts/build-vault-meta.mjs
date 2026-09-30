#!/usr/bin/env node
// Writes data/vault-meta.json (chainId -> address -> {protocol, assetSymbol, name}) from a vault discovery list:
// a JSON array of { protocol, name, address, asset: { symbol } }.
//
//   pnpm --filter @specfirst/web board:meta -- <discovery.json> [--chain-id 143] [--out data/vault-meta.json]
//
// Entries of other chains already in the output file are kept; this chain's entries are replaced.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(here, '..');

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  let input;
  let chainId = 143;
  let out = path.join(webRoot, 'data', 'vault-meta.json');
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chain-id') chainId = Number(argv[++i]);
    else if (a === '--out') out = path.resolve(process.cwd(), argv[++i]);
    else if (!input) input = path.resolve(process.cwd(), a);
    else {
      console.error(`board:meta: unexpected argument ${a}`);
      process.exit(2);
    }
  }
  if (!input || !Number.isSafeInteger(chainId) || chainId <= 0) {
    console.error('usage: build-vault-meta.mjs <discovery.json> [--chain-id 143] [--out data/vault-meta.json]');
    process.exit(2);
  }
  if (!process.features?.typescript) {
    console.error('board:meta: this Node has no built-in TypeScript type stripping. Use Node 22.18+ (or 23.6+).');
    process.exit(1);
  }
  const { toVaultMetaEntries, mergeVaultMeta } = await import('../lib/board/meta.ts');
  const { entries, dropped } = toVaultMetaEntries(JSON.parse(await readFile(input, 'utf8')));
  let existing = null;
  try {
    existing = JSON.parse(await readFile(out, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const merged = mergeVaultMeta(existing, chainId, entries);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(merged, null, 2)}\n`);
  console.log(`board:meta: ${Object.keys(entries).length} vaults for chain ${chainId} -> ${path.relative(process.cwd(), out)}${dropped ? ` (${dropped} without a valid address left out)` : ''}`);
}

main().catch((err) => {
  console.error(`board:meta: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
