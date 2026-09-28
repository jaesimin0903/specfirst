/**
 * Rehearsal plan for the vault surface every specfirst project carries (test/specfirst/IVault.sol):
 * deposit, withdraw, setRewardRate, pause, unpause. The plan is a pure list so tests can check its
 * shape without a chain.
 */

export type ActorRole = 'user' | 'owner' | 'attacker';

export interface ActorRef {
  role: ActorRole;
  /** Index among users; 0 for owner and attacker. */
  index: number;
}

export type NormalAction =
  | { kind: 'deposit'; actor: ActorRef; units: number }
  /** fraction of the actor's current vault balance, in quarters (1..4) */
  | { kind: 'withdraw'; actor: ActorRef; quarters: number }
  | { kind: 'set-reward-rate'; rate: number }
  | { kind: 'pause' }
  | { kind: 'unpause' }
  /** Attacker contract deposits through Attacker.execute. */
  | { kind: 'attacker-deposit'; units: number }
  /** Attacker contract withdraws a quarter of its balance; the receive hook replays it once, legitimately. */
  | { kind: 'attacker-withdraw' };

export type RevertKind =
  | 'unauthorized-set-reward-rate'
  | 'unauthorized-pause'
  | 'overdraw-withdraw'
  | 'deposit-while-paused'
  | 'reentry';

export const REVERT_KINDS: readonly RevertKind[] = [
  'unauthorized-set-reward-rate',
  'unauthorized-pause',
  'overdraw-withdraw',
  'deposit-while-paused',
  'reentry',
];

export type PlanStep = { expectRevert: false; action: NormalAction } | { expectRevert: true; kind: RevertKind };

const u = (index: number): ActorRef => ({ role: 'user', index });

/** One cycle of normal traffic. Pause is always directly followed by unpause. */
function normalCycle(users: number): NormalAction[] {
  const user = (i: number) => u(i % users);
  return [
    { kind: 'deposit', actor: user(0), units: 4 },
    { kind: 'deposit', actor: user(1), units: 4 },
    { kind: 'deposit', actor: user(2), units: 4 },
    { kind: 'set-reward-rate', rate: 100 },
    { kind: 'withdraw', actor: user(0), quarters: 1 },
    { kind: 'attacker-deposit', units: 8 },
    { kind: 'pause' },
    { kind: 'unpause' },
    { kind: 'withdraw', actor: user(1), quarters: 2 },
    { kind: 'deposit', actor: user(0), units: 2 },
    { kind: 'attacker-withdraw' },
    { kind: 'withdraw', actor: user(2), quarters: 1 },
    { kind: 'set-reward-rate', rate: 250 },
    { kind: 'deposit', actor: user(1), units: 2 },
  ];
}

/**
 * `normal` normal steps (cycled) with `revert` revert-expected steps (kinds cycled) interleaved:
 * deposit-while-paused right after a pause, reentry after the attacker has a balance, the rest spread
 * evenly. A pause is added (and counted as normal) when the plan needs one but the normal steps have none.
 */
export function planRehearsal(opts: { users: number; normal: number; revert: number; attacker: boolean }): PlanStep[] {
  const cycle = normalCycle(Math.max(1, opts.users)).filter(
    (a) => opts.attacker || (a.kind !== 'attacker-deposit' && a.kind !== 'attacker-withdraw'),
  );
  const normal: NormalAction[] = [];
  for (let i = 0; normal.length < opts.normal; i++) {
    const a = cycle[i % cycle.length]!;
    // Never end on a pause: the vault must be usable after the rehearsal.
    if (a.kind === 'pause' && normal.length === opts.normal - 1) {
      normal.push({ kind: 'deposit', actor: u(0), units: 1 });
      continue;
    }
    normal.push(a);
  }

  const kinds: RevertKind[] = [];
  const available = REVERT_KINDS.filter((k) => opts.attacker || k !== 'reentry');
  for (let i = 0; i < opts.revert; i++) kinds.push(available[i % available.length]!);

  const steps: PlanStep[] = normal.map((action) => ({ expectRevert: false, action }));
  const insertAfter = (pred: (s: PlanStep) => boolean, fallback: number, step: PlanStep) => {
    const idx = steps.findIndex(pred);
    steps.splice(idx >= 0 ? idx + 1 : Math.min(fallback, steps.length), 0, step);
  };
  const spread = kinds.filter((k) => k !== 'deposit-while-paused' && k !== 'reentry');
  spread.forEach((kind, i) => {
    const pos = Math.floor(((i + 1) * steps.length) / (spread.length + 1));
    steps.splice(pos, 0, { expectRevert: true, kind });
  });
  for (const kind of kinds.filter((k) => k === 'reentry')) {
    insertAfter((s) => !s.expectRevert && s.action.kind === 'attacker-withdraw', steps.length, { expectRevert: true, kind });
  }
  for (const kind of kinds.filter((k) => k === 'deposit-while-paused')) {
    if (!steps.some((s) => !s.expectRevert && s.action.kind === 'pause')) {
      steps.push({ expectRevert: false, action: { kind: 'pause' } }, { expectRevert: false, action: { kind: 'unpause' } });
    }
    let idx = -1;
    steps.forEach((s, i) => {
      if (idx < 0 && !s.expectRevert && s.action.kind === 'pause' && !(steps[i + 1]?.expectRevert)) idx = i;
    });
    if (idx < 0) idx = steps.findIndex((s) => !s.expectRevert && s.action.kind === 'pause');
    steps.splice(idx + 1, 0, { expectRevert: true, kind });
  }
  return steps;
}
