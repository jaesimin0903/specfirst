/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @specfirst/core's package entry point (dist/index.js) re-exports everything: lock.ts (node:fs),
  // agent/replay.ts (node:fs/promises, node:os, execa), spec/hash.ts (node:crypto for sha256Hex),
  // fuzz/forge.ts (execa -> child_process). This package only needs canonicalJson from
  // @specfirst/core, in a "use client" component (ReportHashCheck), but the workspace package has
  // no separate entry point for just the hash utilities and its exports map only exposes ".", so a
  // deep import isn't available; see docs/plan.md 3.8 / the task's instruction to import
  // canonicalJson from @specfirst/core rather than duplicate it. None of these Node-only paths are
  // ever reached from browser code (canonicalJson touches neither the filesystem nor a subprocess),
  // so stubbing them for the client bundle is the standard fix, not a behavior change.
  //
  // Two steps are needed, not one: webpack5 treats a bare `node:fs`-style specifier as a reserved
  // URI scheme, resolved before resolve.alias/fallback ever run, so aliasing "node:fs" alone does
  // nothing (still errors "Unhandled scheme"). NormalModuleReplacementPlugin strips the `node:`
  // prefix first so the request becomes an ordinary bare specifier ("fs"), which then hits the
  // plain-name alias below.
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource) => {
          resource.request = resource.request.replace(/^node:/, '');
        }),
      );
      config.resolve.alias = {
        ...config.resolve.alias,
        execa: false,
        child_process: false,
        crypto: false,
        fs: false,
        os: false,
        net: false,
        tls: false,
        events: false,
      };
    }
    return config;
  },
};

export default nextConfig;
