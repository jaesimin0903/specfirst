import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * The server holds no key and never signs or sends: nothing in src reads a key, builds a wallet, signs or sends a
 * transaction. The e2e test shows the same from the outside (only GETs and eth_call leave the process).
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const FORBIDDEN = [
  /PRIVATE_KEY/,
  /privateKeyToAccount|mnemonicToAccount|hdKeyToAccount/,
  /createWalletClient|walletClient/i,
  /sendTransaction|sendRawTransaction|writeContract|signMessage|signTypedData|signTransaction/,
  /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/,
];

describe('no keys, no signing', () => {
  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

  it('covers every source file', () => {
    expect(files.sort()).toEqual(['address.ts', 'api.ts', 'chain.ts', 'config.ts', 'decide.ts', 'findings.ts', 'index.ts', 'levels.ts', 'schemas.ts', 'server.ts', 'text.ts', 'verdict.ts', 'watch.ts']);
  });

  for (const pattern of FORBIDDEN) {
    it(`no source file matches ${pattern}`, () => {
      for (const f of files) expect(readFileSync(join(SRC, f), 'utf8'), f).not.toMatch(pattern);
    });
  }
});
