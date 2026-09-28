import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

/** Anvil's well-known dev keys (mnemonic "test test ... junk"). Local chain only. */
export const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
] as const;

export const SKIP_ANVIL = process.env.SPECFIRST_SKIP_ANVIL === '1';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface Anvil {
  url: string;
  port: number;
  proc: ChildProcess;
  stop(): Promise<void>;
}

/** Starts `anvil` on a free port and resolves once eth_chainId answers. */
export async function startAnvil(extraArgs: string[] = []): Promise<Anvil> {
  const port = await freePort();
  const proc = spawn('anvil', ['--port', String(port), '--silent', ...extraArgs], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`anvil did not start on ${url}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    proc,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
}
