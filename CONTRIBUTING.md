# Contributing

Thanks for your interest in contributing.

## License

By submitting a contribution (pull request, patch, issue with a code
suggestion, or any other form), you agree that your contribution is
licensed under the project's license — **Apache License 2.0** — as
described in the [`LICENSE`](./LICENSE) file. You also certify that
you have the right to submit the contribution under that license
(e.g. it is your original work, or you have permission from the
copyright holder).

No separate contributor license agreement (CLA) or developer
certificate of origin (DCO) sign-off is required at this stage.

## Before opening a PR

1. Run the full preflight locally and make sure it's green:
   ```
   npm run preflight
   ```
   This runs `tsc --noEmit` + the golden verifiers (pack, message,
   transpile, enum-lookup, echo, cache-params) + the MCP smoke test.
2. If your change touches the wire protocol, add or update a
   byte-exact golden in `scripts/verify-msg.ts` against a real
   capture. See the "When adding a new pidHigh" note in
   [`CLAUDE.md`](./CLAUDE.md) for the rationale.
3. If your change adds a new MCP tool, add it to the expected-tools
   list in `scripts/smoke-server.ts`.

## Questions / security issues

- General questions → open a GitHub issue once the repo is public.
- Security issues → see [`SECURITY.md`](./SECURITY.md).
