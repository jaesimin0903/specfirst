import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import type { ChainReader } from '../src/chain.js';
import { configFromEnv } from '../src/config.js';
import { createSpecfirstServer } from '../src/server.js';
import { ADDR, NOW } from './helpers.js';
import { startMockApi, type Running } from './mocks.js';

/*
 * The server in process, over the SDK's in-memory transport, with a chain reader that breaks its own contract (it
 * throws instead of answering "unread"): check_before_moving_funds still answers caution, never a tool error.
 */

let api: Running;
beforeAll(async () => {
  api = await startMockApi();
});
afterAll(() => api.close());

describe('check_before_moving_funds when something past the input breaks', () => {
  it('answers caution with incomplete-evidence instead of a tool error', async () => {
    const broken: ChainReader = {
      latest: () => {
        throw new Error('reader bug');
      },
      feePerDay: async () => ({ read: 'unread', reason: 'not used' }),
    };
    const server = createSpecfirstServer({ config: configFromEnv({}), api: createApi({ base: api.url, timeoutMs: 3000 }), chain: broken, now: () => NOW });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'specfirst-test', version: '0.0.1' });
    await client.connect(clientSide);
    try {
      const r = (await client.callTool({ name: 'check_before_moving_funds', arguments: { address: ADDR.morpho, action: 'deposit' } })) as {
        isError?: boolean;
        structuredContent?: { decision: string; reasons: Array<{ code: string; text: string }> };
      };
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent!.decision).toBe('caution');
      const incomplete = r.structuredContent!.reasons.find((x) => x.code === 'incomplete-evidence');
      expect(incomplete?.text).toContain('reader bug');
      // Bad input is still a tool error that says what is wrong.
      const bad = (await client.callTool({ name: 'check_before_moving_funds', arguments: { address: '0x12', action: 'deposit' } })) as { isError?: boolean };
      expect(bad.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
