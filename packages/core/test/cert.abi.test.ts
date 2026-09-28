import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { certificateRegistryAbi } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const built = path.resolve(here, '../../contracts/out/CertificateRegistry.sol/CertificateRegistry.json');

describe('certificateRegistryAbi', () => {
  it.skipIf(!existsSync(built))('matches the forge build of CertificateRegistry.sol', () => {
    const abi = JSON.parse(readFileSync(built, 'utf8')).abi;
    expect(certificateRegistryAbi).toEqual(abi);
  });
});
