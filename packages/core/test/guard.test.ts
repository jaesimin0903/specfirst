import { describe, expect, it } from 'vitest';
import { checkEditable, checkLockedTouched, detectEnvBranches, lockedPaths, type LockFile } from '../src/index.js';

describe('checkEditable', () => {
  it('allows paths under editable directories and returns the rest, untracked or not', () => {
    const changed = ['src/StakingVault.sol', 'src/lib/Math.sol', 'script/Deploy.s.sol', 'srcx/evil.sol', 'README.md'];
    expect(checkEditable(changed, ['src/'])).toEqual(['script/Deploy.s.sol', 'srcx/evil.sol', 'README.md']);
  });

  it('treats an entry without a trailing slash as a directory or an exact file', () => {
    expect(checkEditable(['src/A.sol', 'src', 'docs/x.md'], ['src', 'docs/x.md'])).toEqual([]);
    expect(checkEditable(['src2/A.sol'], ['src'])).toEqual(['src2/A.sol']);
  });

  it('rejects paths that escape the project', () => {
    expect(checkEditable(['src/../foundry.toml', '/etc/passwd'], ['src/'])).toEqual(['src/../foundry.toml', '/etc/passwd']);
  });

  it('normalises ./ prefixes', () => {
    expect(checkEditable(['./src/A.sol'], ['./src/'])).toEqual([]);
  });
});

describe('checkLockedTouched', () => {
  it('matches exact files and directory prefixes', () => {
    const locks = ['test/specfirst/', 'foundry.toml', 'lib/forge-std/'];
    const changed = ['src/A.sol', 'test/specfirst/regressions/UF-1.t.sol', 'foundry.toml', 'foundry.toml.bak', 'lib/forge-std/src/Test.sol'];
    expect(checkLockedTouched(changed, locks)).toEqual([
      'test/specfirst/regressions/UF-1.t.sol',
      'foundry.toml',
      'lib/forge-std/src/Test.sol',
    ]);
  });

  it('lockedPaths covers properties, config, submodules, spec and .specfirst', () => {
    const lock = {
      properties: [{ path: 'test/specfirst/Invariants.t.sol' }],
      submodules: [{ path: 'lib/forge-std', commit: null }],
      specPath: 'spec/vault.spec.yaml',
    } as unknown as LockFile;
    const locks = lockedPaths(lock);
    const changed = ['lib/forge-std', 'spec/vault.spec.yaml', '.specfirst/lock.json', 'remappings.txt', '.gitmodules', 'src/A.sol'];
    expect(checkLockedTouched(changed, locks)).toEqual(changed.slice(0, 5));
  });
});

describe('detectEnvBranches', () => {
  const diff = [
    'diff --git a/src/V.sol b/src/V.sol',
    'index 1111111..2222222 100644',
    '--- a/src/V.sol',
    '+++ b/src/V.sol',
    '@@ -10,3 +10,11 @@ contract V {',
    '     uint256 x;',
    '+    uint256 id = block.chainid;',
    '+    if (block.number > 100) revert();',
    '+    require(block.timestamp >= deadline);',
    '+    require(tx.origin == msg.sender);',
    '+    assembly { s := extcodesize(a) }',
    '+    if (address(this).code.length == 0) {}',
    '+    uint256 t = block.timestamp; // stored, not compared',
    '+    // if (block.number > 1) is only a comment',
    '     uint256 y;',
    '-    require(tx.origin != address(0)); // moved below',
    '+    require(tx.origin != address(0)); // moved below',
  ].join('\n');

  it('reports each pattern on added lines with new-file line numbers', () => {
    const w = detectEnvBranches(diff);
    expect(w.map((x) => [x.kind, x.line])).toEqual([
      ['block.chainid', 11],
      ['block.number-compare', 12],
      ['block.timestamp-compare', 13],
      ['tx.origin', 14],
      ['extcodesize', 15],
      ['address(this).code', 16],
    ]);
    expect(w.every((x) => x.file === 'src/V.sol')).toBe(true);
  });

  it('ignores removed and context lines, plain reads, comments and moved lines', () => {
    const w = detectEnvBranches(diff);
    expect(w.some((x) => x.text.includes('stored, not compared'))).toBe(false);
    expect(w.some((x) => x.text.startsWith('//'))).toBe(false);
    expect(w.filter((x) => x.kind === 'tx.origin')).toHaveLength(1);
  });

  it('handles new files and comparisons written right to left', () => {
    const newFile = [
      'diff --git a/src/N.sol b/src/N.sol',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/N.sol',
      '@@ -0,0 +1,2 @@',
      '+contract N {',
      '+  function f() external view { require(1000 < block.number); }',
    ].join('\n');
    expect(detectEnvBranches(newFile)).toEqual([
      { kind: 'block.number-compare', file: 'src/N.sol', line: 2, text: 'function f() external view { require(1000 < block.number); }' },
    ]);
  });

  it('returns nothing for an empty diff', () => {
    expect(detectEnvBranches('')).toEqual([]);
  });
});
