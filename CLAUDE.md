# AM4 Tone Agent — Claude Code Context

This file is read by Claude Code at the start of every session.

---

## Project Purpose
Build a local MCP server that lets Claude Desktop control a Fractal AM4
guitar amp modeler over USB/MIDI via natural language conversation.

## Current Phase
See **`docs/STATE.md`** first. It names the current phase, the single next
action, and recent findings — start every session there. `STATE.md` is kept
current; the numbered plan docs (`01-` through `04-`) are longer-lived
reference.

Hardware tasks the founder owes (USB captures, round-trip tests on the
device, reference dumps) are queued in **`docs/HARDWARE-TASKS.md`**.
Check it at session start — if anything sits at 🔜 Pending, flag it before
proceeding with work that depends on it. Append a new `HW-NNN` entry any
time you identify a hardware action you can't perform yourself, with
detailed steps the founder can follow without re-reading the backlog.

> Phase 0 (feasibility) completed 2026-04-14. Phase 1 (protocol RE) is in
> progress — USB capture of AM4-Edit's outgoing traffic is the current
> blocker. See `STATE.md` for exact next steps.

## Stack
- TypeScript / Node.js (**ES modules**, not CommonJS — `package.json` has
  `"type": "module"`, `tsconfig.json` uses `"module": "NodeNext"`)
- `tsx` is the TypeScript runner for scripts (not `ts-node`) — invoke via
  `npm run <script>` or `npx tsx <path>`
- node-midi for USB MIDI (native module — requires VS Build Tools on Windows
  dev machines; end users get a packaged `.exe` and need neither)
- @modelcontextprotocol/sdk for MCP
- No framework. No ORM. Keep it simple.

## Target User
A working guitarist with a Claude account — not a developer. Every UX,
install, and distribution decision prioritizes the non-technical user.
The MVP ships as a signed Windows `.exe` that configures Claude Desktop
automatically; users never install Node, a C++ toolchain, or edit JSON.
See `docs/DECISIONS.md` for the full reasoning and rejected alternatives.

## Decision Log
Non-obvious architectural and library choices live in `docs/DECISIONS.md`.
Read it before proposing changes to: the MIDI library, module system,
TypeScript runner, distribution model, or wiki-scrape workflow.

## External References
Manuals, protocol specs, factory preset banks, and generated working docs
are catalogued in `docs/REFERENCES.md`. Check there first before searching
the web — most common questions are answered by one of the local PDFs
(all extracted to `.txt` for grep-ability).

## AM4 SysEx Quick Reference

### Device ID
AM4 model byte: `0x15`

### Message Envelope
```
F0 00 01 74 15 [function] [payload...] [checksum] F7
```

### Checksum
```typescript
const checksum = bytes.reduce((a, b) => a ^ b, 0) & 0x7F;
// where bytes = everything from F0 through last payload byte
```

### Known Working Commands
```
Mode: Presets  — F0 00 01 74 15 12 48 4A F7
Mode: Scenes   — F0 00 01 74 15 12 49 4B F7
Mode: Effects  — F0 00 01 74 15 12 4A 48 F7
Mode: Amp      — F0 00 01 74 15 12 58 5A F7
Mode: Tuner    — F0 00 01 74 15 12 18 1A F7
```

### Preset-location Naming
A01–Z04 (104 preset locations total, 4 per bank, 26 banks A–Z). Use
`parseLocationCode` / `formatLocationCode` from `src/protocol/locations.ts`.

## Fractal terminology (use these exact words)

Fractal's docs use specific words for AM4 concepts. Our code and user-
facing strings MUST match, because one of the words — "slot" — has
opposite meanings in casual use:

| Term | What it means |
|---|---|
| **Bank** | A letter A–Z grouping 4 preset locations |
| **Preset** | The stored patch (blocks + params + scenes + name) |
| **Location** | Where a preset is stored. "A01" through "Z04", 104 total. NOT called a "slot" |
| **Slot** (or **effect slot**) | A position 1–4 in a preset's signal chain. The slot is the container; the block is what fills it |
| **Block** | The effect occupying a slot (amp, drive, delay, reverb, chorus, …) |
| **Scene** | One of 4 performance variations within a preset (bypass + channel state, not a copy of the blocks themselves) |
| **Channel** | Per-block A/B/C/D variation of that block's settings |

Anti-patterns to avoid:
- "preset slot" when you mean "preset location" (wrong — preset slots
  don't exist; presets occupy *locations*, not slots)
- "save to slot N" in user-facing text (wrong — "save to location N")
- "effect in slot 3" is correct; "effect in position 3" is also OK but
  "slot" matches Fractal's wording

## Performance budget

MCP tool calls are part of a conversation. Users tolerate short waits
during overt batch actions, but individual tool calls should feel
instantaneous.

- **Ideal:** < 200 ms per tool call (single `set_param`, `set_block_
  type`, etc.). SysEx round-trips against the AM4 land in 30–60 ms,
  with a 300 ms ack window.
- **Acceptable:** < 1 s for tools that make 2–5 wire transactions
  (`apply_preset` with a handful of blocks and params).
- **Requires explicit progress:** anything > 1 s must tell the user
  upfront ("This will probe 16 preset locations, ~1 second"). Never
  make the user wait silently.
- **Avoid altogether:** designs that require > 5 s of wire work in a
  single conversational turn. Either cache, batch into a dedicated
  command, or design around the probe.

When writing new tool specs, estimate the wire-round-trip count
up front. SysEx is serial — N reads ≈ N × 50 ms minimum. If the math
says > 1 s, redesign before implementing.

## Key Constraints
- Windows ThinkPad. Use Windows paths where relevant.
- node-midi requires node-gyp / native build tools on Windows.
  If build fails, try: `npm install --global windows-build-tools`
- AM4 USB driver must be installed before any MIDI communication.
  Driver: https://www.fractalaudio.com/am4-downloads/
- Never write to a preset slot without reading it first.
- Always confirm before overwriting non-empty, non-factory slots.

## File Conventions
- All .syx binary samples go in samples/
- All reverse-engineering notes go in docs/SYSEX-MAP.md
- All block parameter tables go in docs/BLOCK-PARAMS.md
- Sniffing session logs go in docs/SESSIONS.md
- Tests that require hardware are in tests/integration/ and skipped in CI

## Testing and sign-off

- **`npm run preflight`** is the single command to run before every
  commit. It runs `tsc --noEmit` and then `npm test`, which chains the
  three protocol-layer goldens:
  - `verify-pack` — 10-sample pack/unpack round-trip.
  - `verify-msg` — built messages vs. captured wire bytes (byte-exact,
    including checksum).
  - `verify-transpile` — IR → command sequence goldens.
- `npm test` alone runs just the goldens; handy for iterating on the
  protocol layer without waiting for the typecheck.
- `npm run test:jest` is reserved for future Jest-based unit tests (the
  scaffolding exists; there are no tests yet).
- **When adding a new pidHigh to `params.ts`, add a matching case to
  `verify-msg.ts` built from captured bytes.** That is the only guard
  against misreading septet-encoded pidHighs as little-endian bytes
  (the class of bug that hit Session 08 — see SYSEX-MAP.md §6a note).

## Living documentation — update before declaring a session complete

Certain docs must stay current because future sessions (human and
Claude) consult them as source of truth. When the underlying thing
changes, the doc must change in the same session — not as a followup.
Cheaper than discovering drift later.

| Doc | Update when… |
|---|---|
| `docs/STATE.md` | A substantive session happens. Always — it's the session-start orientation doc. Update "single next action" and any relevant "recent breakthroughs" entry. |
| `docs/PROMPT-COVERAGE.md` | A new MCP tool ships, a protocol decode lands, or founder testing surfaces a new user prompt pattern. Flip ⚠ → ✅ when the blocker clears; flip ❌ → ⚠ when a research item gets a concrete decode plan; add new rows for unanticipated prompts. |
| `docs/HARDWARE-TASKS.md` | A HW-NNN item completes (mark ✅ + capture outcome), or a new hardware action is identified that Claude can't perform alone (append HW-NNN with step-by-step instructions). |
| `docs/04-BACKLOG.md` | A new backlog item is identified, an existing item ships / re-scopes / is superseded, or a cross-reference between items is worth recording. |
| `docs/SYSEX-MAP.md` | A new protocol decode is confirmed against captured bytes. Include the concrete capture reference and byte-exact example. |
| `docs/SESSIONS.md` | A session produces a substantive finding worth a chronological entry (decodes, major tool changes, hardware-verified behavior). STATE.md is the summary; SESSIONS.md is the log. |

**Session-wrap check.** Before declaring work complete, walk the table
above and update whichever rows apply to what changed. A one-line
reply at session end naming which docs were updated helps the founder
verify nothing was missed.

## Do Not
- Do not use AM4-Edit as a dependency or requirement
- Do not hardcode preset-location values — always use the A01–Z04 naming
- Do not skip the safety read before any write operation
- Do not guess parameter names — verify against AM4 manual or sniffed data
- Do not issue any preset-store / save-to-location SysEx command from
  `scripts/probe.ts`. Probe is read-only forever.
- Do not write to any preset location other than **Z04** during
  reverse-engineering. Z04 is the designated scratch location — back it
  up before every write, never touch A01–Z03 in dev work. See
  `docs/DECISIONS.md` (write safety).

---

# Claude Project Setup Instructions

These instructions are for setting up the **Claude.ai Project** that will
serve as the knowledge base and planning environment for this app.
(Different from Claude Code — this is the conversational project.)

## What Goes in the Claude Project

### Required Knowledge Files
Upload these to the project's knowledge base:

1. **AM4 Owner's Manual** (PDF)
   - Download from: https://www.fractalaudio.com/am4-downloads/
   - This is the primary reference for all parameter names and navigation

2. **AM4 Block Parameter Reference** (when built)
   - src/knowledge/ files exported as readable reference
   - All effect type names, parameter ranges, channel behavior

3. **This planning document set**
   - 01-PROJECT-VISION.md
   - 02-FEASIBILITY-PROOF-PLAN.md
   - 03-ARCHITECTURE.md
   - 04-BACKLOG.md

4. **Amber 311 Build Sheet** (example of target output quality)
   - The preset build sheet already created in the other project
   - Shows the depth of research and parameter detail expected

### Project System Prompt (for Claude Project)

```
You are the design and planning agent for the AM4 Tone Agent project —
a local MCP server that lets users control a Fractal AM4 guitar amp
modeler through natural language conversation with Claude Desktop.

Your responsibilities:
1. Help design and refine the SysEx protocol layer based on research
   and sniffing session findings
2. Build detailed, authentic AM4 preset configurations when asked,
   using the AM4 manual and block parameter reference as ground truth
3. Never guess parameter names — always verify against the manual
4. Flag any parameter or type name you cannot confirm with [FLAG — VERIFY]
5. When building presets, research the artist's verified gear for the
   specific recording era of the song
6. Always produce complete preset IR objects (all 4 blocks, all scenes,
   all channels) — never partial configs
7. Track the backlog and suggest prioritization based on dependencies

AM4 constraints to always apply:
- 4 effect slots per preset (linear or simple parallel routing)
- 4 scenes per preset
- Up to 4 channels (A/B/C/D) per block
- 104 preset locations total (A01 through Z04, 26 banks × 4 per bank)
- Preset-location naming is always Fractal native format (e.g. M01, not
  "slot 49"). "Slot" refers to a signal-chain position 1–4, not a
  preset location — do not use the two interchangeably.
```

## Connecting Claude Desktop MCP (when server is ready)

Edit: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "am4-tone-agent": {
      "command": "node",
      "args": ["C:\\path\\to\\am4-tone-agent\\dist\\server\\index.js"],
      "env": {}
    }
  }
}
```

Restart Claude Desktop after editing. The AM4 tools will appear in the
tools panel when the server starts successfully.
