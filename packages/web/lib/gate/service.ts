import type { PublicClient } from 'viem';
import { testnetClient } from '../desk/clients';
import { describeReadError } from '../board/attestations';
import { gateAddress } from './contract';
import { readGateView, type GateChainReader } from './read';
import type { GatePageJson } from './types';

/** The server client as the reader readGateView takes; reads made together go out as one multicall. */
export function gateReaderOf(client: PublicClient): GateChainReader {
  return {
    readContract: (args) => client.readContract(args as never) as Promise<unknown>,
    getLogs: (args) => client.getLogs(args),
    getBlock: () => client.getBlock(),
  };
}

/** /watch/gate: "not deployed" without NEXT_PUBLIC_SPECFIRST_GATE_10143, else the gate read now or why it could not be. */
export async function gatePageView(env: Record<string, string | undefined> = process.env, client: PublicClient = testnetClient()): Promise<GatePageJson> {
  const address = gateAddress(env);
  if (!address) return { deployed: false };
  try {
    return { deployed: true, address, view: await readGateView(gateReaderOf(client), address), error: null };
  } catch (err) {
    return { deployed: true, address, view: null, error: describeReadError(err) };
  }
}
