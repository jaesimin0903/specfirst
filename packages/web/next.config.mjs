/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Client code imports only "@specfirst/core/hash" (spec/hash.ts, viem only), never the package root,
  // which re-exports Node-only modules (execa, node:fs). No webpack aliasing is needed.
};

export default nextConfig;
