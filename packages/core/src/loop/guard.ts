import type { LockFile } from '../lock/lock.js';
import { LOCK_DIR, PROPERTIES_DIR } from '../lock/lock.js';

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
}

function escapes(p: string): boolean {
  return p.startsWith('/') || p.split('/').includes('..');
}

/** Entry ending in "/" is a directory prefix, anything else must match exactly or be a directory prefix. */
function covered(p: string, entry: string): boolean {
  const e = norm(entry);
  if (e === '' || e === '.' || e === './') return true;
  const dir = e.endsWith('/') ? e : `${e}/`;
  return p === e.replace(/\/$/, '') || p.startsWith(dir);
}

/** Changed paths (untracked included) that fall outside every `contract.editable` entry. */
export function checkEditable(changedPaths: readonly string[], editable: readonly string[]): string[] {
  return changedPaths.map(norm).filter((p) => escapes(p) || !editable.some((e) => covered(p, e)));
}

/** Changed paths that hit a locked file or a locked directory ("dir/" entries are prefixes). */
export function checkLockedTouched(changedPaths: readonly string[], lockFiles: readonly string[]): string[] {
  return changedPaths.map(norm).filter((p) =>
    lockFiles.some((l) => {
      const e = norm(l);
      return e.endsWith('/') ? p.startsWith(e) || p === e.slice(0, -1) : p === e;
    }),
  );
}

/** Every path the lock covers (plan 3.3), in the form checkLockedTouched expects. */
export function lockedPaths(lock: LockFile): string[] {
  return [
    `${PROPERTIES_DIR}/`,
    ...lock.properties.map((f) => f.path),
    'foundry.toml',
    'remappings.txt',
    ...lock.submodules.map((s) => `${s.path}/`),
    ...lock.submodules.map((s) => s.path),
    lock.specPath,
    `${LOCK_DIR}/`,
    '.gitmodules',
  ];
}

export type EnvBranchKind =
  | 'block.chainid'
  | 'block.number-compare'
  | 'block.timestamp-compare'
  | 'tx.origin'
  | 'extcodesize'
  | 'address(this).code';

export interface EnvBranchWarning {
  kind: EnvBranchKind;
  file: string;
  /** Line number in the new version of the file. */
  line: number;
  text: string;
}

const CMP = '(?:==|!=|<=|>=|<|>)';
const ENV_PATTERNS: Array<[EnvBranchKind, RegExp]> = [
  ['block.chainid', /\bblock\.chainid\b/],
  ['block.number-compare', new RegExp(`block\\.number\\s*${CMP}|${CMP}\\s*block\\.number\\b`)],
  ['block.timestamp-compare', new RegExp(`block\\.timestamp\\s*${CMP}|${CMP}\\s*block\\.timestamp\\b`)],
  ['tx.origin', /\btx\.origin\b/],
  ['extcodesize', /\bextcodesize\b/],
  ['address(this).code', /address\s*\(\s*this\s*\)\s*\.code\b/],
];

function stripComment(line: string): string {
  const i = line.indexOf('//');
  return i >= 0 ? line.slice(0, i) : line;
}

/**
 * Scans added lines of a unified diff for environment-dependent branches (plan 3.3). A line that was
 * only moved (the same text is also removed in that file) is not new and does not warn.
 */
export function detectEnvBranches(diffText: string): EnvBranchWarning[] {
  const out: EnvBranchWarning[] = [];
  let file = '';
  let newLine = 0;
  let added: Array<{ line: number; text: string }> = [];
  let removed = new Set<string>();

  const flush = () => {
    for (const a of added) {
      const code = stripComment(a.text);
      if (removed.has(a.text.trim())) continue;
      for (const [kind, re] of ENV_PATTERNS) {
        if (re.test(code)) out.push({ kind, file, line: a.line, text: a.text.trim() });
      }
    }
    added = [];
    removed = new Set();
  };

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      flush();
      file = '';
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? file : p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ')) {
      if (!file) file = raw.slice(4).trim().replace(/^a\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+')) {
      added.push({ line: newLine, text: raw.slice(1) });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      removed.add(raw.slice(1).trim());
    } else if (raw.startsWith(' ')) {
      newLine += 1;
    }
  }
  flush();
  return out;
}
