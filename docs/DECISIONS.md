# Architectural Decisions — AM4 Tone Agent

Append-only log of non-obvious choices. Each entry explains what was chosen,
why, and what was rejected. Future Claude Code sessions should read this
before proposing architectural changes.

---

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-14 | **Target user = guitarist with a Claude account, not a developer.** Every install, UX, and distribution choice must prioritize a non-technical guitarist over a technical one. | The product's value lands if a working musician can describe a tone and hear it on the AM4. Anything that forces the user to install Node, a C++ toolchain, or edit JSON defeats the premise. |
| 2026-04-14 | **Distribute the MVP as a packaged binary (`.exe`), not as an npm package or source install.** | Follows from the target-user decision. Guitarists should double-click one file. Packaging tool will be chosen when Phase 5 starts (candidates: `@yao-pkg/pkg`, `nexe`, or an Electron shell if a GUI is ever added). Rejected: asking users to install VS Build Tools; depending on upstream `node-midi` prebuilds (release cadence not controlled by us). |
| 2026-04-14 | **Keep `node-midi` as the MIDI library.** Do NOT swap to `@julusian/midi`, `jzz`, or Python `mido` to dodge the Windows native-build friction. | Library swaps to avoid setup pain are technical debt. The native build is a dev-machine problem (solved once with VS Build Tools) and a distribution problem (solved once by the packaged-binary decision above). Neither warrants a runtime dependency change. |
| 2026-04-14 | **ES modules, not CommonJS.** `package.json` sets `"type": "module"`; `tsconfig.json` uses `"module": "NodeNext"`; `__dirname` is derived from `import.meta.url` where needed. | Node 24+ defaults to ESM for loose `.ts` files, the `@modelcontextprotocol/sdk` is ESM-native, and ESM is the forward-compatible choice. A one-session migration now avoids future churn. |
| 2026-04-14 | **Use `tsx` to run TypeScript directly, not `ts-node`.** | `tsx` supports ESM + TS with zero config. `ts-node`'s ESM mode requires tsconfig gymnastics that we would redo every time a new script is added. One-line dependency swap; no runtime implication. |
| 2026-04-14 | **Raw scraped wiki pages (`docs/wiki/`) are gitignored.** The committed ground-truth lives in `docs/BLOCK-PARAMS.md` (and later, more structured extracts). | Wiki pages are ~2 MB of loosely-converted markdown that change when upstream changes; committing them would create noisy diffs and merge conflicts for no product benefit. The scraper (`scripts/scrape-wiki.ts`) is reproducible, so the raw pages can always be regenerated. |
| 2026-04-14 | **Phase 1 ships a "live-tweak" MVP before any preset-binary-format work.** ~~Concretely: get `0x08` firmware handshake, `0x14` read preset number, `0x0F` read preset name, and `0x02` set one parameter on the currently loaded preset. That unlocks a demo-able product without decoding the preset binary.~~ | ~~Reverse-engineering the AM4 preset binary format is the single biggest open risk (undocumented, solo effort, similar projects stall here). The live-tweak path uses only documented-for-Axe-Fx-II function IDs and gives us working AM4 control end-to-end before we commit time to the risky binary work.~~ **SUPERSEDED 2026-04-14 same day** — see next row. |
| 2026-04-14 | **Protocol family is Axe-Fx III, not Axe-Fx II.** Session 02 proved AM4 uses the public Axe-Fx III 3rd-party MIDI spec (0x0A / 0x0B / 0x0C / 0x0D / 0x0E / 0x13 / 0x14) with model byte 0x15. Axe-Fx II commands (0x02 / 0x0F / etc.) return rc=0x05 NACK. Block IDs follow the Axe-Fx III enum (ID_INPUT1=37, ID_OUTPUT1=42, ID_CAB1=62, …) with AM4-specific extensions above ID 200 (observed: ID 206 = almost certainly the Amp block). | Empirical — confirmed against a real AM4 on 2026-04-14. The Axe-Fx II template in earlier SYSEX-MAP drafts was the wrong family. |
| 2026-04-14 | **MVP scope: preset authoring, not live control.** The MVP is "Claude builds a complete preset from a natural-language description and stores it to a slot the user picks." This includes: full block chain, all 4 scenes with per-block channel assignment, and a library of reusable channel-block configurations. It does NOT include: live toggle/bypass, real-time parameter tweaks, or scene-switch-as-feature. | Project owner's explicit direction 2026-04-14. Rationale: toggling/switching is easy to do on the device itself — Claude's value is tone-composition, which no existing AM4 tool offers. This means we cannot avoid the preset-binary reverse-engineering work; it's on the critical path. The earlier "live-tweak de-risking MVP" is retired. |
| 2026-04-14 | **Architecture: puppet the device, don't encode preset binaries.** The AM4 preset `.syx` format is per-export scrambled (confirmed Session 03) and cracking the scramble is weeks of work with uncertain payoff. Instead, the tone agent will (1) send a sequence of parameter-set commands over the AM4's live editor protocol to configure the device's working buffer, (2) issue the already-decoded store command (`0x77/0x78/0x79`) to persist. AM4-Edit itself works this way — it never constructs preset binaries in-memory. | The scramble affects ~22% of bytes per export even with zero content changes, making byte-level RE infeasible without tools like Ghidra on AM4-Edit's 21 MB native binary. Puppeting the device uses the same mechanism AM4-Edit uses, respects AM4 firmware as the canonical encoder, and unblocks the MVP as soon as we RE the `0x01` parameter-set command shape (Session 04's goal). Rejected: statistical multi-export analysis (days of tedious capture), Ghidra disassembly (open-ended timeline), factory-preset-copy-only MVP (user explicitly rejected — "the point is to have described a tone and have it set in the device"). |
| 2026-04-14 | **Preset-write safety protocol.** Destructive write commands (store-to-slot) are NEVER issued outside an explicit write-experiment context. Rules: (1) `scripts/probe.ts` stays read-only forever; (2) write experiments live in a separate `scripts/write-test.ts` with a prominent warning banner; (3) all write testing uses slot **Z04** as the scratch slot — never any other slot — with a backup to disk taken before every write; (4) each write requires explicit user confirmation during the RE phase; (5) in the eventual MCP layer, the read-classify-backup-confirm-write flow is non-bypassable. | CLAUDE.md already says "never write without reading first" and "always confirm before overwriting non-empty non-factory slots." This decision tightens the operational rule set so nothing in the dev process violates those principles. |
| 2026-04-14 | **The wiki scraper parses MediaWiki tables into GFM markdown** instead of stripping them to a placeholder. | The tables on `MIDI_SysEx`, `Presets`, `Effects_list`, etc. contain the actual protocol spec (function IDs, block IDs, parameter IDs). Stripping them destroys the value of the scrape. Trade-off: slightly more scraper complexity, but one-time cost. |

---

## How to update this file

Add a new row for any decision that a future session could plausibly
second-guess without this context. Examples of decisions that belong here:

- Picking one library over another (and what was rejected).
- Choosing a distribution model, install flow, or licensing approach.
- Module-system or build-tool choices (CJS vs ESM, bundler selection).
- Data-format commitments (IR schema, preset serialization, MCP tool shape).

Examples of decisions that do NOT belong here:

- Renaming a variable.
- Adding a unit test.
- Fixing a bug (belongs in commit messages).
- Internal refactors with no external surface change.

Keep rationales to 1–3 sentences. Link out to longer context (sprint docs,
RFCs, external references) rather than inlining.
