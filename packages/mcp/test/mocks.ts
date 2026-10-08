import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkAttestationRegistryAbi } from '@specfirst/core';
import { checkSubscriptionsAbi } from '@specfirst/core/subs';
import { decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, getAddress, parseAbiParameters, type Hex } from 'viem';
import { ATTESTATION_STATUS } from '../src/chain.js';
import { ADDR, fixture, fixtureText, NAMES, REGISTRY, REPORT_FILE, type Name } from './helpers.js';

/*
 * Local stand-ins for the Specfirst web API and a Monad testnet RPC, serving the fixtures. Both record every
 * request, so a test can show the server only ever sends GETs and eth_call.
 */

export interface Running {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

async function listen(server: Server, requests: string[]): Promise<Running> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BY_ADDRESS = new Map<string, Name>(NAMES.map((n) => [ADDR[n].toLowerCase(), n]));

/** The web API with the fixture vaults, their reports, the watcher feed and status. */
export function startMockApi(o: { feed?: unknown } = {}): Promise<Running> {
  const requests: string[] = [];
  const feed = (o.feed ?? fixture('api/feed-page.json')) as { events: Array<{ seq: number }> } & Record<string, unknown>;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const send = (status: number, body: unknown, raw = false) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(raw ? (body as string) : JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'GET only' });
    const url = new URL(req.url ?? '/', 'http://x');
    let m: RegExpExecArray | null;
    if ((m = /^\/api\/v1\/vaults\/143\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname))) {
      const name = BY_ADDRESS.get(m[1]!.toLowerCase());
      if (name) return send(200, fixture(`api/vault-${name}.json`));
      return send(404, { ...(fixture('api/vault-unknown.json') as object), address: m[1]!.toLowerCase() });
    }
    if ((m = /^\/reports\/143\/(0x[0-9a-f]{40})\/[^/]+\.json$/.exec(url.pathname))) {
      const name = BY_ADDRESS.get(m[1]!);
      if (name) return send(200, fixtureText(REPORT_FILE[name]), true);
      return send(404, { error: 'not found' });
    }
    if ((m = /^\/api\/v1\/watch\/vaults\/143\/(0x[0-9a-fA-F]{40})$/.exec(url.pathname))) {
      const name = BY_ADDRESS.get(m[1]!.toLowerCase());
      if (name === 'upshift') return send(200, fixture('api/watch-vault-upshift.json'));
      return send(404, { ...(fixture('api/watch-vault-unknown.json') as object), address: m[1]!.toLowerCase() });
    }
    if (url.pathname === '/api/v1/watch/feed') {
      const limit = Number(url.searchParams.get('limit') ?? 40);
      const before = url.searchParams.get('before');
      const older = before === null ? feed.events : feed.events.filter((e) => e.seq < Number(before));
      const page = older.slice(0, limit);
      return send(200, { ...feed, events: page, hasOlder: older.length > page.length });
    }
    if (url.pathname === '/api/v1/watch/status') return send(200, fixture('api/watch-status.json'));
    return send(404, { error: 'no such route' });
  });
  return listen(server, requests);
}

type RawRead = { attestation: Record<string, string | number>; isCompliant: boolean; issuerCurrent: boolean };

/** A Monad testnet RPC whose registry holds the fixture attestations and whose CheckSubscriptions charges 0.05 MON a day. */
export function startMockRpc(o: { chainId?: number; offchainLookup?: string } = {}): Promise<Running> {
  const requests: string[] = [];
  const reads = fixture('chain/attestations.json') as Record<Name, RawRead>;
  const bySubject = new Map<string, RawRead>(NAMES.map((n) => [ADDR[n].toLowerCase(), reads[n]]));

  function call(to: string, data: Hex): { result: Hex } | { error: { code: number; message: string; data?: Hex } } {
    if (getAddress(to) === getAddress(REGISTRY)) {
      if (o.offchainLookup) {
        // EIP-3668 OffchainLookup(sender, urls, callData, callbackFunction, extraData), with sender = the registry.
        const args = encodeAbiParameters(parseAbiParameters('address, string[], bytes, bytes4, bytes'), [getAddress(to), [o.offchainLookup], '0x1234', '0x12345678', '0x']);
        return { error: { code: 3, message: 'execution reverted', data: `0x556f1830${args.slice(2)}` as Hex } };
      }
      const d = decodeFunctionData({ abi: checkAttestationRegistryAbi, data });
      const subject = String((d.args as readonly unknown[] | undefined)?.[1] ?? '').toLowerCase();
      const read = bySubject.get(subject);
      if (d.functionName === 'latest' || d.functionName === 'isCompliant') {
        if (!read) {
          const revert = encodeErrorResult({ abi: checkAttestationRegistryAbi, errorName: 'NoAttestation', args: d.args as never });
          return { error: { code: 3, message: 'execution reverted', data: revert } };
        }
        if (d.functionName === 'isCompliant') return { result: encodeFunctionResult({ abi: checkAttestationRegistryAbi, functionName: 'isCompliant', result: read.isCompliant } as never) };
        const a = read.attestation;
        const struct = {
          subjectChainId: BigInt(a.subjectChainId!),
          subject: a.subject,
          standardId: a.standardId,
          blockNumber: BigInt(a.blockNumber!),
          implementationKey: a.implementationKey,
          subjectCodeHash: a.subjectCodeHash,
          suiteHash: a.suiteHash,
          reportHash: a.reportHash,
          passCount: Number(a.passCount),
          failCount: Number(a.failCount),
          inconclusiveCount: Number(a.inconclusiveCount),
          notApplicableCount: Number(a.notApplicableCount),
          passedBitmap: BigInt(a.passedBitmap!),
          failedBitmap: BigInt(a.failedBitmap!),
          issuedAt: BigInt(a.issuedAt!),
          issuer: a.issuer,
          status: ATTESTATION_STATUS.indexOf(a.status as never),
          supersededBy: BigInt(a.supersededBy!),
          revokeReasonHash: a.revokeReasonHash,
          reportURI: a.reportURI,
        };
        return { result: encodeFunctionResult({ abi: checkAttestationRegistryAbi, functionName: 'latest', result: [BigInt(a.id!), struct] } as never) };
      }
      if (d.functionName === 'isIssuer') return { result: encodeFunctionResult({ abi: checkAttestationRegistryAbi, functionName: 'isIssuer', result: true } as never) };
    } else {
      const d = decodeFunctionData({ abi: checkSubscriptionsAbi, data });
      if (d.functionName === 'feePerDay') return { result: encodeFunctionResult({ abi: checkSubscriptionsAbi, functionName: 'feePerDay', result: 50_000_000_000_000_000n } as never) };
    }
    return { error: { code: -32601, message: 'not mocked' } };
  }

  const server = createServer(async (req: IncomingMessage, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const answer = (msg: { id: unknown; method: string; params?: unknown[] }) => {
      requests.push(msg.method);
      if (msg.method === 'eth_chainId') return { jsonrpc: '2.0', id: msg.id, result: `0x${(o.chainId ?? 10143).toString(16)}` };
      if (msg.method === 'eth_call') {
        const p = msg.params?.[0] as { to: string; data?: Hex; input?: Hex };
        return { jsonrpc: '2.0', id: msg.id, ...call(p.to, (p.data ?? p.input)!) };
      }
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not served here` } };
    };
    const parsed = JSON.parse(body) as unknown;
    const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed as never);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  return listen(server, requests);
}

/** A port nothing listens on: the address of a server that is down. */
export async function deadUrl(): Promise<string> {
  const s = createServer();
  const r = await listen(s, []);
  await r.close();
  return r.url;
}
