import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Property template files copied by `specfirst init`. Sourced from
 * examples/staking-vault/test/specfirst/ (the staking vault sample); agent-generated
 * or per-contract-shape templates are roadmap, out of this hackathon's scope.
 */
export const TEMPLATE_FILES = [
  'IVault.sol',
  'SpecfirstProps.sol',
  'Handler.sol',
  'Attacker.sol',
  'Invariants.t.sol',
  'SpecfirstProbe.sol',
] as const;

/**
 * Absolute path to packages/cli/templates, resolved relative to this module so it
 * works both from src (ts-node/vitest) and from dist (built CLI).
 */
export function templatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/lib/templates.ts -> ../../templates ; dist/lib/templates.js -> ../../templates
  return join(here, '..', '..', 'templates');
}
