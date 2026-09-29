import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultCacheDir,
  depositRevertCounts,
  ERC4626_PROPERTIES,
  ERC4626_UPSTREAM,
  EVENTS_DIR,
  FORGE_STD_PIN,
  forgeEnv,
  parseStandardForgeJson,
  prepareErc4626Workspace,
  type StandardWorkspace,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A clean checkout of `commit` under <cache>/standards/<any>/lib/<name>, or null. Read only. */
function cachedCheckout(cacheDir: string, name: string, commit: string): string | null {
  const standards = path.join(cacheDir, 'standards');
  if (!existsSync(standards)) return null;
  for (const d of readdirSync(standards)) {
    const dir = path.join(standards, d, 'lib', name);
    if (!existsSync(path.join(dir, '.git'))) continue;
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
      const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir }).toString().trim();
      if (head === commit && dirty === '') return dir;
    } catch {
      /* not a usable checkout */
    }
  }
  return null;
}

const CACHE = defaultCacheDir();
const UPSTREAM = cachedCheckout(CACHE, 'erc4626-tests', ERC4626_UPSTREAM.commit);
const FORGE_STD = cachedCheckout(CACHE, 'forge-std', FORGE_STD_PIN.commit);
const SKIP = !UPSTREAM || !FORGE_STD || process.env.SPECFIRST_SKIP_FORGE === '1';

/**
 * Offline: compiles the shipped harness against the pinned upstream and forge-std, and runs it against
 * local mock vaults (fixtures/standards/review). Runs only when a pinned checkout is already in the cache
 * ($SPECFIRST_CACHE_DIR or the default); the cache is only read, the workspace is a fresh temp directory.
 */
describe.skipIf(SKIP)('ERC-4626 harness with forge, offline (pinned cache present)', { timeout: 300_000 }, () => {
  let root: string;
  let ws: StandardWorkspace;
  const forge = (args: string[]) =>
    execa('forge', args, { cwd: ws.dir, env: forgeEnv({ SF_RUN_ID: 'offline-test' }), extendEnv: false, reject: false, maxBuffer: 256 * 1024 * 1024 });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-harness-'));
    ws = await prepareErc4626Workspace({
      cacheDir: root,
      upstream: { repo: `file://${UPSTREAM}`, commit: ERC4626_UPSTREAM.commit },
      forgeStd: { repo: `file://${FORGE_STD}`, commit: FORGE_STD_PIN.commit },
    });
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('the harness, the positive control and the control vault compile', async () => {
    const p = await forge(['build', '--offline']);
    expect(p.exitCode, String(p.stderr)).toBe(0);
    for (const f of ['SpecfirstERC4626.t.sol/SpecfirstERC4626Test.json', 'SpecfirstERC4626Control.t.sol/SpecfirstERC4626Control.json', 'BrokenVault.sol/BrokenVault.json']) {
      expect(existsSync(path.join(ws.dir, 'out', f)), f).toBe(true);
    }
  });

  it('M1 and L3 on mock vaults: a reverting maxDeposit fails maxDeposit only; deposit reverts below maxDeposit are recorded', async () => {
    await copyFile(path.join(here, 'fixtures/standards/review/M.sol'), path.join(ws.dir, 'src/M.sol'));
    await copyFile(path.join(here, 'fixtures/standards/review/Exp.t.sol'), path.join(ws.dir, 'test/Exp.t.sol'));
    const paused = await forge(['test', '--offline', '--match-contract', '^ModePaused$', '--fuzz-runs', '8', '--fuzz-seed', '0x1', '--json', '-vv']);
    const results = parseStandardForgeJson(String(paused.stdout), ERC4626_PROPERTIES)!;
    expect(results.filter((r) => r.status !== 'pass').map((r) => [r.id, r.status, r.reason])).toEqual([['maxDeposit', 'fail', 'paused']]);

    const closed = await forge(['test', '--offline', '--match-contract', '^ModeDepositRevertsBelowMax$', '--match-test', 'test_deposit\\(', '--fuzz-runs', '8', '--fuzz-seed', '0x1', '--json', '-vv']);
    const events = await readFile(path.join(ws.dir, EVENTS_DIR, 'offline-test.deposit-below-max.log'), 'utf8');
    const keys = Object.keys((Object.values(JSON.parse(String(closed.stdout))) as Array<{ test_results: object }>)[0]!.test_results);
    expect(depositRevertCounts(events, keys).get('test_deposit')).toBeGreaterThan(1000);
  });
});
