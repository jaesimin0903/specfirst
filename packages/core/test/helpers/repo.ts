import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { parseSpec, type Spec } from '../../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SPEC_TEXT_PATH = path.join(here, '../fixtures/specs/valid.spec.yaml');

export const VAULT = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract StakingVault {
    mapping(address => uint256) public balances;
    uint256 public totalStaked;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        totalStaked += msg.value;
    }

    function withdraw(uint256 amount) external {
        uint256 bal = balances[msg.sender];
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok);
        balances[msg.sender] = bal - amount;
        totalStaked -= amount;
    }
}
`;

export const INVARIANTS = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
contract SpecfirstInvariants {
    function invariant_INV_1() public view {}
}
`;

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return String((await execa('git', args, { cwd })).stdout);
}

export const GIT_ID = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false'];

export async function writeFiles(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (content === null) {
      await rm(p, { force: true });
    } else {
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, content);
    }
  }
}

/** Temporary git repository shaped like a user project, with one commit. */
export async function initRepo(extra: Record<string, string | null> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'specfirst-loop-'));
  await git(dir, 'init', '-q', '-b', 'main');
  await writeFiles(dir, {
    'foundry.toml': '[profile.default]\nsrc = "src"\n',
    'remappings.txt': 'forge-std/=lib/forge-std/src/\n',
    '.gitignore': '.specfirst/\nout/\ncache/\n',
    'src/StakingVault.sol': VAULT,
    'test/specfirst/Invariants.t.sol': INVARIANTS,
    'spec/vault.spec.yaml': await readFile(SPEC_TEXT_PATH, 'utf8'),
    ...extra,
  });
  await git(dir, 'add', '-A');
  await git(dir, ...GIT_ID, 'commit', '-q', '-m', 'init');
  return dir;
}

export async function loadSpec(): Promise<Spec> {
  return parseSpec(await readFile(SPEC_TEXT_PATH, 'utf8'));
}

export interface PatchStep {
  files: Record<string, string | null>;
  /** Accepted steps are committed in the scratch clone, so later patches build on them. Default true. */
  accept?: boolean;
}

/** Builds `git apply`-able patches in a scratch clone, each relative to the previously accepted state. */
export async function buildPatches(repo: string, steps: PatchStep[]): Promise<string[]> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'specfirst-patch-'));
  await execa('git', ['clone', '-q', repo, scratch]);
  const out: string[] = [];
  try {
    for (const step of steps) {
      await writeFiles(scratch, step.files);
      await git(scratch, 'add', '-A', '--intent-to-add');
      out.push(`${await git(scratch, 'diff', 'HEAD')}\n`);
      if (step.accept ?? true) {
        await git(scratch, 'add', '-A');
        await git(scratch, ...GIT_ID, 'commit', '-q', '-m', 'step');
      } else {
        await git(scratch, 'reset', '-q', '--hard');
        await git(scratch, 'clean', '-fdq');
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return out;
}

/** Vault source with an extra marker line, to produce distinct non-empty patches. */
export function vaultWith(marker: string): string {
  return VAULT.replace('    uint256 public totalStaked;\n', `    uint256 public totalStaked;\n    // ${marker}\n`);
}
