# Specfirst

Spec-first verification certificates for Monad contracts. Built for Monad Metropolis, Track 4.

Plan of record: see docs/plan.md. Status: week 1, scaffolding.

## Keys

Commands that send transactions read `DEPLOYER_PRIVATE_KEY` and `ISSUER_PRIVATE_KEY` from the environment; they do not read `.env` on their own. Copy `.env.example` to `.env`, fill it in, and run with Node's env loader:

```
node --env-file=.env packages/cli/dist/index.js <command>
```

`.gitignore` ignores every name that starts with `.env` except `.env.example`, so a Finder copy such as `.env copy.example` is not committed by accident.

## License

MIT, see `LICENSE`. Exceptions: files whose first line is `SPDX-License-Identifier: AGPL-3.0` extend [a16z/erc4626-tests](https://github.com/a16z/erc4626-tests), which is AGPL-3.0, and carry that license:

- `packages/core/src/standards/erc4626/SpecfirstERC4626.t.sol`
- `packages/core/src/standards/erc4626/control/SpecfirstERC4626Control.t.sol`
- `packages/core/test/fixtures/standards/review/Exp.t.sol`

The upstream suite itself is not in this repository; it is fetched at a pinned commit at run time (see `docs/adr/0003-third-party-standard-properties.md`). The vendored `forge-std` keeps its own MIT OR Apache-2.0 license.
