import pc from 'picocolors';
import type { FuzzParams, FuzzResult, LoopEvent, Spec } from '@specfirst/core';

/** Width of the left-aligned stage column ("spec", "fuzz #1", "fix #1", ...). */
const LABEL_WIDTH = 9;
const MAX_CALLS_SHOWN = 12;
const INDENT = ' '.repeat(LABEL_WIDTH);

export function stage(label: string, text: string): string {
  return `${pc.bold(label.padEnd(LABEL_WIDTH - 1))} ${text}`;
}

export function cont(text: string): string {
  return `${INDENT}${text}`;
}

function firstLine(s: string, max = 160): string {
  const line = s.split('\n').find((l) => l.trim()) ?? s;
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Per-invariant lines for one judge result: red cross with the counterexample, green check, yellow error. */
export function fuzzDetail(fuzz: FuzzResult): string[] {
  const out: string[] = [];
  for (const r of fuzz.results) {
    if (r.status === 'pass') {
      out.push(pc.green(`  ✓ ${r.invariantId}`));
    } else if (r.status === 'error') {
      out.push(pc.yellow(`  ! ${r.invariantId}  ${firstLine(r.error ?? 'error')}`));
    } else {
      const ce = r.counterexample;
      out.push(pc.red(`  ✗ ${r.invariantId}  ${firstLine(ce?.reason ?? 'failed')}`));
      const calls = ce?.callSequence ?? [];
      calls.slice(0, MAX_CALLS_SHOWN).forEach((c, i) => out.push(pc.dim(`      ${i + 1}. ${c}`)));
      if (calls.length > MAX_CALLS_SHOWN) out.push(pc.dim(`      ... ${calls.length - MAX_CALLS_SHOWN} more calls`));
    }
  }
  return out;
}

export interface RunLogContext {
  spec: Spec;
  params: FuzzParams;
  agentLabel: string;
  /** Last judge result the backend produced; fuzz-result events only carry counts. */
  lastFuzz: () => FuzzResult | null;
}

/**
 * Turns loop events into the human-readable progress log. Returns a function that renders one
 * event to zero or more lines; keeps just enough state to print the implement-skip line once.
 */
export function createRunLog(ctx: RunLogContext): (e: LoopEvent) => string[] {
  let sawIteration = false;
  return (e) => {
    switch (e.type) {
      case 'loop-start':
        return [];
      case 'iteration-start': {
        const lines: string[] = [];
        if (!sawIteration && e.phase === 'fix') {
          lines.push(stage('impl', pc.dim(`${ctx.spec.contract.path ?? ctx.spec.contract.name} exists, implement step skipped`)));
        }
        sawIteration = true;
        if (e.phase === 'implement') {
          lines.push(stage('impl', `${ctx.agentLabel} writes ${ctx.spec.contract.path ?? ctx.spec.contract.name}`));
        } else {
          const seed = ctx.params.seed !== undefined ? ` seed=${ctx.params.seed}` : '';
          lines.push(stage(`fuzz #${e.iteration}`, pc.dim(`forge runs=${ctx.params.runs} depth=${ctx.params.depth}${seed}`)));
        }
        return lines;
      }
      case 'fuzz-result': {
        const total = e.pass + e.fail + e.error;
        const fuzz = ctx.lastFuzz();
        const secs = fuzz && !e.reused ? `  ${fuzz.wallclockSec.toFixed(1)}s` : '';
        const summary =
          e.fail + e.error === 0
            ? pc.green(`${e.pass}/${total} pass`)
            : pc.red(`${e.fail} fail`) + (e.error ? pc.yellow(`, ${e.error} error`) : '') + `, ${e.pass} pass`;
        const lines = [cont(`${summary}${secs}${e.reused ? pc.dim('  (code unchanged, previous result reused)') : ''}`)];
        if (fuzz) lines.push(...fuzzDetail(fuzz));
        return lines;
      }
      case 'agent-start':
        return [stage(e.phase === 'fix' ? `fix #${e.iteration}` : 'impl', `${ctx.agentLabel}`)];
      case 'agent-result':
        return [
          cont(
            `${e.changedPaths.length > 0 ? `changed ${e.changedPaths.join(', ')}` : pc.yellow('no change')}  ${pc.dim(formatUsd(e.costUsd))}`,
          ),
        ];
      case 'rejected':
        return [cont(pc.red(`✗ rejected: ${e.reason}`))];
      case 'env-warning':
        return [cont(pc.yellow(`! env branch ${e.warning.kind} at ${e.warning.file}:${e.warning.line}  ${e.warning.text}`))];
      case 'accepted':
        return [cont(pc.green(`accepted ${e.commit.slice(0, 7)}`))];
      case 'loop-end':
        return [];
    }
  };
}
