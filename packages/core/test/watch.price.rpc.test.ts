import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http, parseEther, type Address, type Hex } from 'viem';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { classifiedErrorText, isSubjectRpcFailure } from '../src/attest/subjectCheck.js';
import { isRpcServerError } from '../src/chain/transport.js';
import {
  anvilChain,
  createChainClients,
  deployDemoFactory,
  deployDemoToken,
  deployDemoVault,
  depositIntoDemoVault,
  isContractAnswer,
  isNodeError,
  liveWatchEffects,
  MULTICALL3_ADDRESS,
  precheckErc4626,
  readSharePrice,
  rpcTransport,
  setDemoVaultLoss,
  type ChainClients,
} from '../src/index.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MULTICALL3 = JSON.parse(readFileSync(path.join(here, 'fixtures/watch/multicall3.json'), 'utf8')) as { address: Address; code: Hex };
const VAULT = getAddress('0x00000000000000000000000000000000000000a1');
/** A contract whose every call loops until it runs out of gas: JUMPDEST PUSH1 0 JUMP. */
const BURNER_CODE: Hex = '0x5b600056';
const E18 = 10n ** 18n;

/** A JSON-RPC stub that answers eth_call with `error` and the rest with fixed values; counts the requests it got. */
async function stub(error: { code: number; message: string } | null): Promise<{ url: string; server: Server; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits++;
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const answer = method === 'eth_call' && error ? { error } : { result: method === 'eth_getCode' ? '0x6001' : method === 'eth_chainId' ? '0x7a69' : '0x8f' };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, hits: () => hits };
}

describe('review M3d: an out-of-gas from the node is the contract answering', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('a real viem error for -32603 "EVM error OutOfGas" is a contract answer, not a node error, and is not failed over', async () => {
    const oog = await stub({ code: -32603, message: 'EVM error OutOfGas' });
    const good = await stub(null);
    servers.push(oog.server, good.server);
    const client = createPublicClient({ transport: http(oog.url, { retryCount: 0 }) });
    const err = await client
      .readContract({ address: VAULT, abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }], functionName: 'decimals' })
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect(isNodeError(err)).toBe(false);
    expect(isRpcServerError(err)).toBe(false);
    expect(isContractAnswer(err)).toBe(true);
    expect(isSubjectRpcFailure(err)).toBe(false);
    expect(classifiedErrorText(err)).toMatch(/^out of gas on decimals\(\): /);
    // The share value read and the desk's pre-check take it as the contract's answer.
    expect(await readSharePrice(client, VAULT, 7n)).toMatchObject({ ok: false, reason: expect.stringMatching(/^decimals\(\) at block 7: out of gas on decimals\(\)/) });
    expect(await precheckErc4626(client, VAULT, 7n)).toMatchObject({ ok: false, reason: expect.stringMatching(/^asset\(\) failed at block 7: /) });
    // The watcher's subject transport fails over on node errors: an out-of-gas is not one, every node would give it.
    const watching = createPublicClient({ transport: rpcTransport([oog.url, good.url], { failoverIf: isNodeError }) });
    expect(await readSharePrice(watching, VAULT, 7n)).toMatchObject({ ok: false });
    expect(good.hits()).toBe(0);
  });

  it('a node error under the same code is still a node error and still fails over', async () => {
    const broken = await stub({ code: -32603, message: 'Error getting block by number' });
    servers.push(broken.server);
    const client = createPublicClient({ transport: http(broken.url, { retryCount: 0 }) });
    await expect(readSharePrice(client, VAULT, 7n)).rejects.toThrow(/Error getting block by number/);
  });
});

describe.skipIf(SKIP_ANVIL)('readSharePrice on anvil, with and without Multicall3', { timeout: 120_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let token: Address;
  let vault: Address;
  let dir: string;
  const burner = getAddress('0x0000000000000000000000000000000000000b0b');
  const rpc = (method: string, params: unknown[]) => clients.publicClient.request({ method: method as never, params: params as never });
  const effectsOn = (counted: { multicalls: number }) => {
    const base = clients.publicClient;
    const subjectClient = Object.assign(Object.create(null) as object, base, {
      multicall: (args: Parameters<typeof base.multicall>[0]) => {
        counted.multicalls++;
        return base.multicall(args);
      },
    }) as typeof base;
    return liveWatchEffects({ subjectClient: subjectClient as never, subjectChainId: 31337, subjectRpcUrl: anvil.url, projectDir: dir, runs: 1, reportBaseUrl: 'https://example.org/checks', registry: null, attest: false });
  };

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-price-rpc-'));
    const wallet = clients.wallet(ANVIL_KEYS[0] as Hex);
    await deployDemoFactory({ client: clients.publicClient, wallet });
    token = (await deployDemoToken({ client: clients.publicClient, wallet })).address;
    vault = (await deployDemoVault({ client: clients.publicClient, wallet, asset: token, broken: false })).vault;
    await depositIntoDemoVault({ client: clients.publicClient, wallet, vault, asset: token, amount: parseEther('1') });
    await rpc('anvil_setCode', [burner, BURNER_CODE]);
  }, 120_000);

  afterAll(async () => {
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the live effects use Multicall3 only where it has code; both paths read the same value, and a gas burner is no value, not an RPC failure', async () => {
    const before = { multicalls: 0 };
    const plain = effectsOn(before);
    const block = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
    const one = { ok: true, assetsPerShare: E18, shareDecimals: 18, scale: 0 };
    expect(await plain.sharePrice!(vault, block)).toEqual(one);
    expect(await plain.sharePrice!(vault, block, { decimals: 18, scale: 0 })).toEqual(one);
    expect(before.multicalls).toBe(0);

    await rpc('anvil_setCode', [MULTICALL3.address, MULTICALL3.code]);
    expect(MULTICALL3.address).toBe(MULTICALL3_ADDRESS);
    const after = { multicalls: 0 };
    const batched = effectsOn(after);
    expect(await batched.sharePrice!(vault, block)).toEqual(one);
    expect(await batched.sharePrice!(vault, block, { decimals: 18, scale: 0 })).toEqual(one);
    expect(after.multicalls).toBe(2);

    const wallet = clients.wallet(ANVIL_KEYS[0] as Hex);
    expect(await setDemoVaultLoss({ client: clients.publicClient, wallet, vault, bps: 42 })).toMatchObject({ sent: true, assets: 42n * 10n ** 14n });
    const later = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
    const fell = { ok: true, assetsPerShare: 9958n * 10n ** 14n, shareDecimals: 18, scale: 0 };
    expect(await plain.sharePrice!(vault, later, { decimals: 18, scale: 0 })).toEqual(fell);
    expect(await batched.sharePrice!(vault, later, { decimals: 18, scale: 0 })).toEqual(fell);

    // A view that burns the call's gas: anvil answers -32603 "EVM error OutOfGas", inside Multicall3 a failed call.
    for (const fx of [plain, batched]) {
      expect(await fx.sharePrice!(burner, later)).toMatchObject({ ok: false, reason: expect.stringMatching(/^decimals\(\) at block \d+: /) });
      expect(await fx.sharePrice!(burner, later, { decimals: 18, scale: 0 })).toMatchObject({ ok: false });
    }
  });

  it('review L6 and L7: no vault is deployed through a factory without code; a loss that rounds to 0 is not sent', async () => {
    const wallet = clients.wallet(ANVIL_KEYS[0] as Hex);
    await expect(deployDemoVault({ client: clients.publicClient, wallet, asset: token, broken: false, factory: getAddress('0x00000000000000000000000000000000000fac70') })).rejects.toThrow(
      /^no DemoVaultFactory at 0x00000000000000000000000000000000000fac70 on this chain/i,
    );
    const empty = (await deployDemoVault({ client: clients.publicClient, wallet, asset: token, broken: false })).vault;
    const nonce = await clients.publicClient.getTransactionCount({ address: wallet.account.address });
    expect(await setDemoVaultLoss({ client: clients.publicClient, wallet, vault: empty, bps: 42 })).toEqual({ sent: false, assets: 0n, totalAssets: 0n });
    expect(await clients.publicClient.getTransactionCount({ address: wallet.account.address })).toBe(nonce);
  });
});
