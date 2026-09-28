#!/usr/bin/env node
// Copies the CertificateRegistry ABI from the built contracts package into
// packages/web/lib/abi so the app can read/decode calls without a build-time
// dependency on @specfirst/contracts (a pure Foundry package, not a pnpm
// workspace member). Mirrors packages/cli/scripts/sync-abi.mjs.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const source = join(root, '..', 'contracts', 'out', 'CertificateRegistry.sol', 'CertificateRegistry.json');
const destDir = join(root, 'lib', 'abi');
const dest = join(destDir, 'CertificateRegistry.json');

async function main() {
  let text;
  try {
    text = await readFile(source, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(
        `sync-abi: ${source} not found. Run \`forge build\` in packages/contracts before building @specfirst/web.`,
      );
      process.exit(1);
    }
    throw err;
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.abi)) {
    console.error('sync-abi: source file has no "abi" array');
    process.exit(1);
  }
  await mkdir(destDir, { recursive: true });
  await writeFile(dest, `${JSON.stringify(parsed.abi, null, 2)}\n`);
  console.log(`sync-abi: wrote ${parsed.abi.length} ABI entries to ${dest}`);
}

main();
