import type { FuzzBackend, FuzzResult, FuzzRunInput } from './types.js';

export type MockScenario = FuzzResult['results'] | ((i: FuzzRunInput, call: number) => FuzzResult['results']);

/** Judge backend for tests: returns the given scenarios in call order and throws once they run out. */
export class MockBackend implements FuzzBackend {
  readonly name = 'mock' as const;
  readonly role = 'judge' as const;
  readonly inputs: FuzzRunInput[] = [];

  constructor(private readonly scenarios: MockScenario[]) {}

  get calls(): number {
    return this.inputs.length;
  }

  async run(i: FuzzRunInput): Promise<FuzzResult> {
    const call = this.inputs.length;
    const scenario = this.scenarios[call];
    if (scenario === undefined) throw new Error(`MockBackend: no scenario for call ${call + 1}`);
    this.inputs.push(i);
    const results = typeof scenario === 'function' ? scenario(i, call) : scenario;
    return { backend: 'mock', wallclockSec: 0, results: structuredClone(results), rawArtifactPath: '' };
  }
}
