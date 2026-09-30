const BOARD_DATA = ['./data/board.json', './data/vaults/**/*.json', './data/vault-meta.json', './data/attestation-txs.json'];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Client code imports only "@specfirst/core/hash" (spec/hash.ts, viem only), never the package root,
  // which re-exports Node-only modules (execa, node:fs). No webpack aliasing is needed.
  // The board pages are prerendered from data/; vault pages that are not prerendered read it on demand.
  // The desk pages and APIs read the same files at request time, plus ../../certs/checks and the worker's status
  // file, which a standalone deployment has to mount next to the app (see README, Request desk).
  outputFileTracingIncludes: {
    '/v/[chainId]/[address]': BOARD_DATA,
    '/check': BOARD_DATA,
    '/check/[requestId]': BOARD_DATA,
    '/desk': BOARD_DATA,
    '/api/v1/vaults/[chainId]/[address]': BOARD_DATA,
    '/api/check/precheck': BOARD_DATA,
    '/api/desk/requests': BOARD_DATA,
    '/api/desk/requests/[id]': BOARD_DATA,
  },
};

export default nextConfig;
