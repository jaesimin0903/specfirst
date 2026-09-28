import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { Abi, Hex } from 'viem';

export interface ContractArtifact {
  contractName: string;
  sourceFile: string;
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  artifactPath: string;
}

export class BuildError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = 'BuildError';
  }
}

/** `forge build` with an explicit out dir, so artifacts never land in the user's tree. */
export async function forgeBuild(projectDir: string, outDir: string, forgeBin = 'forge'): Promise<void> {
  const proc = await execa(forgeBin, ['build'], {
    cwd: projectDir,
    env: { FOUNDRY_OUT: outDir, FOUNDRY_CACHE_PATH: path.join(outDir, '..', 'cache') },
    reject: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.exitCode !== 0) {
    const output = [String(proc.stdout ?? ''), String(proc.stderr ?? '')].filter(Boolean).join('\n');
    throw new BuildError(`forge build failed (exit ${proc.exitCode})`, output);
  }
}

/** Reads `<outDir>/<SourceFile.sol>/<ContractName>.json` as written by forge. */
export async function readArtifact(outDir: string, sourceFile: string, contractName: string): Promise<ContractArtifact> {
  const artifactPath = path.join(outDir, path.basename(sourceFile), `${contractName}.json`);
  let doc: { abi?: Abi; bytecode?: { object?: string }; deployedBytecode?: { object?: string } };
  try {
    doc = JSON.parse(await readFile(artifactPath, 'utf8'));
  } catch (err) {
    throw new BuildError(`cannot read artifact ${artifactPath}: ${(err as Error).message}`, '');
  }
  const bytecode = doc.bytecode?.object;
  if (!doc.abi || !bytecode || bytecode === '0x') {
    throw new BuildError(`artifact ${artifactPath} has no abi or bytecode (abstract contract or interface?)`, '');
  }
  const hex = (s: string) => (s.startsWith('0x') ? s : `0x${s}`) as Hex;
  return {
    contractName,
    sourceFile: path.basename(sourceFile),
    abi: doc.abi,
    bytecode: hex(bytecode),
    deployedBytecode: hex(doc.deployedBytecode?.object ?? '0x'),
    artifactPath,
  };
}
