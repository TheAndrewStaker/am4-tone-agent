# AM4 Sniffing Session Log

Raw capture + annotation per session. One section per session, newest on
top. See `docs/SYSEX-MAP.md` for the consolidated working reference; this
file is the chronological trail that reference is built from.

---

## 2026-04-21 — Session 28 cont — P5-011 items 1 + 4 shipped

Release-gate tool-description audit. Items (1) call-to-action lead and
(4) connector-live sanity note — both needed to keep Claude Desktop
from sliding into the HW-012 "I don't have the connector" failure mode
or the Sailing-transcript "write a spec instead of executing" failure
mode.

### (1) Call-to-action lead on all 12 mutation tools

Uniform first-sentence pair prepended to every tool that changes
hardware state:

> Use this tool to {X} on the user's AM4. Do not produce a written
> spec instead of calling this tool unless the user explicitly asks
> for a dry run.

Tools touched: `apply_preset`, `set_param`, `set_params`,
`set_block_type`, `set_block_bypass`, `save_to_location`,
`save_preset`, `set_preset_name`, `set_scene_name`, `switch_preset`,
`switch_scene`, `reconnect_midi`.

Dry-run phrasing examples ("draft a preset", "without touching the
hardware", "what would the params look like") embedded on the most
creative tools (`apply_preset`, `set_param`) so Claude recognizes an
explicit dry-run ask versus an implicit execute ask. The remaining
mutation tools inherit the short form — the dry-run risk on
`switch_preset` / `reconnect_midi` / `save_preset` is low, but
uniformity helps Claude see the pattern.

### (4) `list_params` live-confirmation line

Two changes:

- **Description rewrite.** `list_params` now tells Claude this tool
  doubles as a connector-sanity check: *"If you were about to tell
  the user 'I don't have the connector in this session' without
  having actually tried a tool call, call this tool first; if it
  returns, the connector is attached and every AM4 tool is available
  to use."*
- **Response-text prepended.** The response opens with a confirmation
  line enumerating every AM4 tool name (apply_preset / set_param /
  set_params / set_block_type / set_block_bypass / switch_preset /
  switch_scene / save_preset / save_to_location / set_preset_name /
  set_scene_name / reconnect_midi) and a nudge to prefer executing
  over spec'ing. The existing catalog of ≥50 params follows.

### Preflight

All existing golden tests pass. Tool count unchanged at 17.

### P5-011 status

- (1) ✅ shipped this session.
- (2) ✅ partial Session 27 cont + closed by Session 28 apply_preset
  response rewrite (save-intent + reversibility language).
- (3) ✅ partial Session 27 cont + closed by Session 28 (working-
  buffer reversibility story).
- (4) ✅ shipped this session.
- (5) ⏳ founder-owed manual Claude-Desktop smoke test — tracked as
  a HARDWARE-TASKS.md item once we line it up.

Tool-description audit is effectively complete from the tool layer.
Remaining release-gate items are (a) the P5-011 (5) manual test,
(b) HW-013 scenes round-trip, (c) the AM4-depth queue (P1-012,
advanced-controls captures, second unit-extension pass).

---

## 2026-04-21 — Session 28 — BK-027 phase 2 shipped; apply_preset scenes[]

No new captures. All HW-011 decodes were in hand from Session 27; the work
was tool-layer orchestration + the HW-012 response-text honesty fix.

### `apply_preset` gains `scenes[]`

New optional top-level field on `apply_preset`:

```typescript
scenes?: Array<{
  index: 1 | 2 | 3 | 4,
  name?: string,                             // ≤32 ASCII-printable
  channels?: { [block: string]: 'A'|'B'|'C'|'D' },
  bypass?: { [block: string]: boolean },     // true = bypass (silent)
}>;
```

Each entry must supply at least one of channels / bypass / name —
empty entries are rejected as a no-op. Scenes may be listed in any
order; the orchestrator walks them sequentially so the AM4 ends up
on the last-configured scene index.

**Execution inside the handler.** After existing slot-level writes
(block placement + per-slot channel param writes + optional name):

1. `buildSwitchScene(sceneIndex)` — standard 64-byte-echo ack shape.
2. `buildSetParam(<block>.channel, idx)` per entry in `channels`.
3. `buildSetBlockBypass(<blockPidLow>, bypassed)` per entry in
   `bypass`. pidHigh=0x0003 with float32 (1.0 bypass / 0.0 active).
4. `buildSetSceneName(sceneIndex, name)` if supplied — uses the
   18-byte `isCommandAck` shape (same register family as preset
   rename), **different predicate from the rest of the loop**.

Ack-shape branching lives in a compact `COMMAND_ACK_KINDS` set so
the existing single-loop send pattern stays intact; the predicate
is picked per-write.

### HW-012 response-text honesty fix (bundled)

Closed in the same change rather than queued separately — the
narrative was already about scenes, and the correct fix was to
remove the idealized per-scene narration entirely rather than add
more. The response now prints:

- **Active scene after this call** (set to the last scene-switch we
  issued; explicitly omitted when the caller didn't configure any
  scenes, so Claude doesn't narrate untouched state).
- **Channels the active scene points at** — sourced from
  `lastKnownChannel` after the send loop finishes. Scene-switch
  writes invalidate the cache at the moment they fire; subsequent
  channel-switch writes within that scene re-populate it. Net: the
  reported channels reflect the LAST scene's pointers, which is
  what the AM4 is actually playing when the call returns.
- **Per-write ack log** unchanged except for the new
  `switch_scene`, `scene_channel`, `bypass`, `scene_name` labels.

When no scenes are touched, the response reverts to the
slot-channels-only story ("last channel written per block… scene
pointers unchanged by this call") — no scene claims from whole
cloth.

### Validation — seven new smoke assertions

Smoke-server picks up scene-path validation (pre-MIDI, no hardware
required):

- empty scene entry (no channels/bypass/name) → *"at least one of
  channels / bypass / name"*.
- duplicate scene index → *"used twice"*.
- unknown block in `scenes[].channels` → path-prefixed error.
- `scenes[].channels` on compressor (no channel register) →
  *"doesn't have channels"*.
- non-A/B/C/D letter → *"must be one of A/B/C/D"*.
- unknown block in `scenes[].bypass` → path-prefixed error.
- `"none"` in `scenes[].bypass` → *"no bypass state"*.

### Preflight

37/37 verify-msg, 16/16 verify-pack, 8/8 verify-echo, 44/44
verify-cache-params, 16/16 verify-enum-lookup, smoke-server 17 tools
+ 16 apply_preset validation assertions (6 kitchen-sink phase 1 + 1
overlong-name + 7 scenes phase 2, + 2 existing lineage paths).
Tool count unchanged at 17.

### Follow-ups

- **P5-011 items 1/4/5** — MCP tool-description audit (call-to-
  action lead per mutation tool, top-of-list connector-live note,
  Claude Desktop manual smoke test). Release-gate.
- **P1-012 channel-aware param writes** — `set_param` / `set_params`
  channel arg. AM4-depth-gate.
- **Second unit-extension pass** — `bipolar_percent`, `count`,
  `semitones` → ~15–20 more params. AM4-depth-gate.

---

## 2026-04-21 — Session 27 — HW-011 captures landed; HW-012 round-trip + two UX findings

### HW-011 — captures complete, decode queued

Founder captured all six session-23 pcapngs: three scene-channel writes
(scene 2/3/4 Amp → B/C/D) and three scene-bypass writes (scene 2 Amp,
scene 3 Drive, scene 4 Reverb). Tshark text dumps generated. Decode
into `buildSetSceneChannel` + `buildSetSceneBypass` is the next action.

HARDWARE-TASKS.md step text clarified before the session: the workflow
now explicitly says *navigate to the target scene first, then start
the capture* so scene-switch writes (already decoded as HW-001) don't
pollute the goldens.

### HW-012 — round-trip worked; two UX findings

Round-trip of the Session 24 per-slot `channels` shape in `apply_preset`
succeeded — 12 writes landed clean, block layout correct, per-channel
amp values confirmed (channel A: Deluxe Verb Normal / gain 3; channel
D: 1959SLP Normal / gain 8; reverb mix 30 on channel A). Underlying
primitives are the same verified ones from Session 19, so no surprise.

Two non-obvious findings surfaced from the conversational surface, both
release-relevant:

**Finding 1 — Claude needed explicit prompting to load the MCP tool.**
First-turn behavior: Claude Desktop produced a spec-only response
("here's the apply_preset call you'd need") and said *"I don't have
the am4-tone-agent connected in this session."* The connector was
attached the whole time. Founder nudged with *"i see the connector.
why can't you?"* → Claude queried the deferred tool list, loaded the
schema, and executed successfully.

Two compounding causes:
- **Deferred tool loading.** MCP connectors expose tools to the model as
  names-only until their schemas are actively loaded into context. This
  is a context-economy tradeoff (the same pattern every Claude Code
  session runs under). The model is supposed to notice when a request
  matches a deferred tool and load it, but the heuristic misfires.
- **Project system prompt biased toward spec output.** The existing
  prompt framed the assistant as a *"design and planning agent"* whose
  primary responsibility was *"build detailed preset configurations."*
  Natural reading: produce a spec. Never mentioned that an MCP
  connector might be attached and should be used.

Fix landed this session: `CLAUDE.md` § "Project System Prompt (for
Claude Project)" rewritten. New prompt defaults to tool use, reserves
spec-only output for explicit dry-run asks ("what would the params
look like", "draft a preset I can review", "design a tone sheet
without touching the hardware"), and tells the assistant to check the
deferred tool list on any AM4 request. Founder needs to re-paste the
updated prompt into the Claude.ai project settings.

Open question — does this address Claude Desktop too, or only the
Claude.ai web Project? The web Project system prompt is set by the
founder; Claude Desktop has no user-configurable app-level prompt, so
the only lever on Desktop behavior is the **MCP tool descriptions**
(registered by the server at `src/server/index.ts`). An audit pass on
those descriptions — making them assertive about when to call rather
than just describing what they do — is queued as **P5-011** (below).
Relevant to the non-technical end-user distribution plan: they won't
be editing any prompt, so tool descriptions are the only surface.

**Finding 2 — `apply_preset` response text overstates scene semantics.**
Claude Desktop's response text after the successful apply_preset
said *"Give it a strum on channel A for the clean tone, then flip to
channel D and you should get that hot Plexi roar."* In reality the
amp was left on channel D (the last channel walked), and scene 1 —
the active scene — was showing channel D = 1959SLP.

Root cause: `apply_preset` phase 1 writes block layout + per-channel
values, but scene→channel pointer writes aren't decoded yet (that's
HW-011, being worked this session). So there's no mechanism for the
tool to say *"scene 1 should use channel A on amp."* All scenes
inherit whatever channel the block was on when apply_preset finished —
which, because channels walk A → B → C → D in canonical order, is
always the highest-letter channel the user supplied values for.

Two fixes, one immediate and one HW-011-dependent:
- **Immediate.** Tighten `apply_preset`'s response text to report the
  *actual* final active channel, not an idealized scene layout.
  Added to BK-027's known-limitations list.
- **HW-011-dependent.** Once bypass/scene-channel writes land, extend
  `apply_preset` with a `scenes[].channels` and `scenes[].bypass` map
  so the tool can explicitly configure each scene. Already planned in
  BK-027 phase 2.

### HW-011 decode — scene-bypass IS new, scene-channel is NOT

Decoded the 6 HW-011 captures plus a 7th the founder added on request
for the bypass-off side (`session-23-scene-2-amp-unbypass.pcapng`).
The original hypothesis — "two new scene-level SET_FLOAT_PARAM writes
with pidHigh encoding (scene index, block slot)" — is **wrong**. What
actually happens:

- **Scene→channel**: no new command. It's the existing channel-switch
  (pidHigh `0x07D2`, value = float(channel index)). The AM4 is
  stateful and scopes the write to whichever scene is currently
  active. Same pattern HW-009 already proved for param writes.
- **Scene→bypass**: IS a new decode. SET_PARAM at the block's own
  pidLow, `pidHigh=0x0003`, action = WRITE, value = `float32(1.0)` to
  bypass / `float32(0.0)` to activate. Still no scene index on the
  wire — also self-scopes to the active scene. Same pidHigh across
  amp / drive / reverb, so presumably across every bypass-capable
  block type.

AM4-Edit's capture traffic also contains a housekeeping pattern
(action `0x0017` on `pidHigh=0x3E81`, zero payload, fires 2× before
and 2× after every real write) that we don't need to emit — our
builders match the real WRITE byte-exact without it.

This is a nice simplification: instead of two new primitives
(`buildSetSceneChannel`, `buildSetSceneBypass`), one new primitive
(`buildSetBlockBypass`) plus a **composition** at the orchestrator
layer (switch scene, then emit channel-switch + bypass per block).
Phase 2 of BK-027 now has a concrete execution plan.

### What landed this session

- `src/protocol/setParam.ts` — new `buildSetBlockBypass(blockPidLow,
  bypassed)` primitive. pidHigh `0x0003`. Symmetric float32 1.0/0.0
  encoding. Rejects 0x0000 (empty slot has no bypass).
- `scripts/verify-msg.ts` — 4 new byte-exact goldens: amp / drive /
  reverb bypass-ON, amp bypass-OFF. **37/37 message-build cases
  match.**
- `src/server/index.ts` — new `set_block_bypass` MCP tool. Takes
  `block: string` + `bypassed: boolean`. Tool count 16 → 17. Tool
  description names the stateful-scoping rule explicitly (*"To
  configure bypass on a specific scene, issue switch_scene first"*).
- `scripts/smoke-server.ts` — expected-tools list updated to 17.
  Smoke test green.
- `README.md` — tool count updated to 17; row added to the cheat-
  sheet.
- `docs/SYSEX-MAP.md` — new §6h "Per-block Bypass Register" with the
  full decode, byte-exact table, and stateful-scoping caveat. Cross-
  referenced in the §7 Axe-Fx-II bypass note as a contrast (AM4's
  shape is different).

### Preflight

`npm run preflight` — TypeScript clean, 33/33 verify-pack, 37/37
verify-msg, 8/8 verify-echo, 44/44 verify-cache-params, smoke-server
17/17 tools + all assertions green. HW round-trip of
`set_block_bypass` deferred to a future session — not a release
blocker since the goldens cover both states and the underlying
SET_PARAM primitive is previously hardware-verified.

### Backlog deltas (end-of-session)

- **BK-010** — closed. Scene support in `apply_preset` is now
  fully unblocked: scene-channel uses the existing channel-switch,
  scene-bypass uses the new primitive, scene-name uses the existing
  rename. All three primitives exist.
- **BK-027 phase 2** — became the next concrete work item. Input
  schema is spec'd already; execution order is: for each
  `scenes[i]` with overrides → `switch_scene(i)` → channel-switch
  per block → `set_block_bypass` per block → scene-name. Response
  text also needs the HW-012 honesty fix (report actual final
  active channel per block, not idealized scene layouts).
- **HW-011** — ✅ archived (moved to bottom of HARDWARE-TASKS.md
  with full decode summary).
- **HW-012** — ✅ archived with both UX findings noted.

---

## 2026-04-21 — Session 27 (cont) — Sailing-transcript UX polish

Founder ran a second Claude Desktop test — *"change my am4 preset to
one for the song sailing by christopher cross"* — as a smoke test of
the commit `7e27b77` state. Tools loaded cleanly (no deferred-tool
miss this time), `lookup_lineage` queried for research, a 21-write
`apply_preset` call landed the preset. Two UX observations from the
transcript, both real gaps:

**Observation 1 — naming is a two-step process when it shouldn't be.**
After the successful apply, Claude volunteered a separate
`save_preset(Z04, "Sailing - C. Cross")` call to name it. The user's
mental model is "a preset is a layout + a name" — those should go
together in one tool call. Fix: added optional top-level `name?` to
`apply_preset`'s schema. Handler emits the rename write (using
`buildSetPresetName` — working-buffer scoped per HW-002) after all
slot writes complete, reports acked/unacked uniformly with the other
writes. Does NOT save — the apply/save boundary is intentional
(separate trust semantics).

**Observation 2 — Claude auto-saved without save intent.** User's
prompt was "change my am4 preset to X" — no persistence language. But
Claude chained `save_preset` anyway. The fix has two sides: the tool
description (tell Claude *when* to call), and the assistant's behavior
(ask before persisting). The tool-description side landed this
session — `save_to_location`, `save_preset`, and `apply_preset`'s
description all gained explicit save-intent / reversibility language:

- `save_to_location` / `save_preset` lead with: *"SAVE INTENT
  REQUIRED: call this tool ONLY when the user has explicitly asked
  to save / persist / store the preset … do NOT call as an automatic
  follow-up to apply_preset — apply is reversible, save is not."*
- `apply_preset` closes with: *"REVERSIBILITY / SAVE INTENT: this
  call hits the WORKING BUFFER only. A bare 'make me a preset for X'
  is a try-it-out ask, not a save ask. When in doubt, apply and ask
  the user whether to save."*

### What else landed this cont

- `src/server/index.ts` — `apply_preset` schema: new top-level
  optional `name` field (32-char zod cap). Handler prepares and
  emits the name write after slot writes, with full ack reporting.
- `scripts/smoke-server.ts` — new assertion for overlong-name
  rejection (33-char name → schema validation error).
- `docs/04-BACKLOG.md` — P5-011 extended into a 5-item rubric with
  per-item status (✅ partial / ⏳ not started). Items 2 (save-intent)
  and 3 (reversibility) partially shipped this session; items 1
  (call-to-action lead on every mutation tool), 4 (top-of-tool-list
  sanity note), 5 (manual Desktop smoke-test) remain to-do.
- `docs/04-BACKLOG.md` — BK-027 status updated to note `name?`
  shipped.
- `docs/PROMPT-COVERAGE.md` — new row for *"Build a preset for
  'Sailing'"* pattern as a representative one-call use case.
- `README.md` — `apply_preset` description updated in the cheat-
  sheet to mention the name field and working-buffer-only scope.

### Preflight

`npm run preflight` — 37/37 verify-msg, 17/17 tools, new overlong-
name assertion green. Zero regressions.

### Backlog deltas

- **BK-027** — status note updated: `name?` shipped this cont,
  phase 2 (scenes) remains the active work item.
- **P5-011** — expanded from a narrative description to a
  structured 5-item rubric with partial-ship markers. Items (2)
  and (3) partially shipped this session against the acute cases
  from the Sailing transcript; full audit across the remaining
  working-buffer tools (items 1, 3-extended, 4, 5) still pending.

---

## 2026-04-19 — Session 25 (cont 2) — P5-010 license + trademark hygiene

Founder decided on Apache-2.0 for patent-retaliation protection.
Private repo stays private; these files only become operative on
distribution.

### Files added

- `LICENSE` — Apache License 2.0, canonical text, `Copyright 2026
  Stephen Staker` in the boilerplate notice.
- `NOTICE` — Apache-2.0 convention. Three sections: project
  copyright, trademark disclaimer ("unaffiliated community tool;
  Fractal Audio / AM4 are Fractal's trademarks"), and third-party
  attribution skeleton for `@modelcontextprotocol/sdk`, `node-midi`,
  `zod`.
- `CONTRIBUTING.md` — minimal: contributions licensed under
  Apache-2.0, `npm run preflight` must pass, new wire-protocol work
  needs a byte-exact golden, new MCP tools need a smoke-server row.
- `SECURITY.md` — vulnerability report contact
  (stephenstaker@gmail.com), scope (MCP server, protocol layer,
  scripts processing untrusted input, future .exe), explicit
  out-of-scope items.
- `package.json` — `"license": "Apache-2.0"`,
  `"author": "Stephen Staker <stephenstaker@gmail.com>"`.

### New backlog item BK-029: project rename

`am4-tone-agent` is trademark-adjacent to Fractal Audio's product.
The NOTICE disclaimer is the minimum legal defense; a
non-trademark-adjacent project name is the cleaner fix. Candidate
name from founder: **"Conversational Presets"** (device-neutral,
descriptive). BK-029 captures the mechanical rename scope:
`package.json` `name`, repo name, LICENSE/NOTICE titles, README,
self-referencing docs, MCP server metadata, tool descriptions.
**Device-name usage stays** — "AM4" is correct factual usage for
the hardware and we're using it as interoperability fair-use.
Block public distribution on BK-029 landing.

### What's still pending for P5-010

- README disclaimer (depends on P5-009 #4 — README itself).
- Final name choice + rename pass (BK-029).

### Preflight

Green (typecheck + 6 goldens + smoke-server). No code paths
touched; files are license / community-docs metadata only.

---

## 2026-04-19 — Session 25 (cont) — startup-banner port scan + P1-010 Session A

Two follow-on non-HW release items after the midi_ports / error-path
work earlier in the session.

### Startup banner now logs port detection (P5-009 #3)

`main()` in `src/server/index.ts` calls `listMidiPorts()` at boot
and logs a verdict to stderr. Claude Desktop surfaces stderr in its
MCP log, so the user sees the server's view of the USB state
before any tool call:

```
AM4 Tone Agent MCP server running on stdio.
Startup port scan: AM4 detected (in: "AM4", out: "AM4").
```

Four verdict states map to the same logic as `list_midi_ports`:

- both directions visible → "AM4 detected (in: ..., out: ...)"
- one direction visible → "AM4 partially visible — one direction missing; check driver"
- zero MIDI ports → "no MIDI ports visible (driver likely not installed)"
- ports present but no AM4 → "AM4 not visible among N inputs / M outputs"

Port enumeration is wrapped in try/catch — if node-midi throws on a
hostile platform, the server still starts and logs the enumeration
failure instead of dying.

### P1-010 Session A — bulk param registration infrastructure

Session A ships the pipeline that closes P1-007's coverage gate
without 400 one-off hardware captures. Three new files + one new
preflight golden:

- `src/protocol/paramNames.ts` — hand-maintained name table. Keyed
  by `(block, id)`. Seed: 20 entries (every in-band name in
  KNOWN_PARAMS today — amp.gain/bass/type, drive.drive/type,
  reverb.mix/type, delay.time/type, and the 11 Tier-3 block Type
  selectors confirmed in Session 18).
- `scripts/gen-params-from-cache.ts` — walks every CONFIRMED cache
  block (per `docs/CACHE-BLOCKS.md`), looks up each record's id in
  paramNames.ts, infers the unit from the cache `c` scale field
  (c=10→knob_0_10, c=100→percent, c=1000→ms, c=1→db, enum→enum),
  and emits `src/protocol/cacheParams.ts` with one
  `KNOWN_PARAMS`-shape entry per surviving record.
- `src/protocol/cacheParams.ts` — generated, committed (like
  cacheEnums.ts). 20 entries for now; grows as paramNames.ts fills.
- `scripts/verify-cache-params.ts` — preflight golden. For every
  key in CACHE_PARAMS, asserts the entry matches KNOWN_PARAMS on
  pidLow/pidHigh/unit/displayMin/displayMax/enumValues. Fails loudly
  on any divergence. 20/20 pass today, which means the generator
  produces the same Param entries the hand-authored registry does.

**Why this matters for release.** P5-009 item 6 flags param
hallucination as a release-blocking UX regression — Claude invents
full-size-Fractal params (mid/treble/presence on amp, feedback/mix
on delay) that AM4 doesn't expose. Today's KNOWN_PARAMS registers
only 25 params across 15 blocks; the cache holds ~200–350
addressable records. Session A unblocks the coverage sweep: each
name added to paramNames.ts is one more param Claude can
meaningfully call. Session B (the name-filling exercise, probably
2–3 sessions of Blocks Guide + AM4-Edit cross-reference work) can
now land without touching the generator or the verifier.

**Out-of-band params stay hand-authored.** Five params in
KNOWN_PARAMS don't appear in the cache at all:
`amp.level` (pidHigh=0x0000, no id=0 record) and
`{amp,drive,reverb,delay}.channel` (pidHigh=0x07D2, no cache row).
These remain declared in `params.ts` directly; the generator
ignores them and the verifier doesn't flag them because they
don't appear in CACHE_PARAMS.

**npm scripts:** `gen-params` regenerates cacheParams.ts after
editing paramNames.ts; `verify-cache-params` runs the golden.
Both are in the `test` chain.

### Files touched (this sub-session)

- `src/server/index.ts` — startup-banner port scan.
- `src/protocol/paramNames.ts` — new, hand-authored name seed.
- `scripts/gen-params-from-cache.ts` — new, generator.
- `src/protocol/cacheParams.ts` — new, generated.
- `scripts/verify-cache-params.ts` — new, golden.
- `package.json` — `gen-params` + `verify-cache-params` scripts
  (verifier added to `test` chain).
- `docs/STATE.md`, `docs/04-BACKLOG.md`, `docs/PROMPT-COVERAGE.md` —
  marked P5-009 #3 shipped, P1-010 Session A shipped.

---

## 2026-04-19 — Session 25 — P5-009 release-polish (list_midi_ports + graceful AM4-not-found)

**Goal:** close the first two P5-009 pre-release ergonomics items —
(1) a way for users (or Claude) to see every MIDI port the server can
see without opening the AM4, and (2) a friendly "AM4 not connected"
error that names the likely cause instead of throwing a stack trace
on the first tool call.

### `list_midi_ports` MCP tool

`src/protocol/midi.ts` gains a connection-free `listMidiPorts()` that
opens short-lived `new midi.Input()` / `new midi.Output()` handles
purely to enumerate port names, then closes them. Each port is tagged
with `direction` and `looksLikeAM4` (substring match on "am4" /
"fractal"). Tool handler in `src/server/index.ts` composes a verdict
line + per-direction listings:

```
AM4 input + output both visible. The server will connect to these on the next tool call.

Inputs (1):
  [0] AM4  ← looks like the AM4

Outputs (1):
  [0] AM4  ← looks like the AM4
```

Three distinct verdict states:

- Both directions visible → "AM4 input + output both visible."
- One direction visible → "Only one of AM4 input/output is visible"
  (driver likely half-installed).
- Zero MIDI ports of any kind → "No MIDI ports of any kind are
  visible" (driver missing).
- Ports present but none match → "AM4 not visible. Check USB
  cable, power, and driver. Also close AM4-Edit."

Safe to call mid-session — doesn't touch the cached AM4 connection
or the stale-handle counter. The smoke-server assertion is
environment-independent: it confirms the tool is wired up and
returns `Inputs` / `Outputs` sections.

### Graceful "AM4 not connected" error

`connectAM4()`'s throw path previously listed raw port tables with
no explanation. Rewritten to lead with three common causes (power /
USB, driver not installed, AM4-Edit port exclusivity), then show
whatever ports *are* visible (with a noPorts branch for the
no-driver case), then point the user at `list_midi_ports` +
`reconnect_midi` as the recovery path.

### Tool count

15 → 16. No protocol change, no golden change (neither new surface
touches a wire message). Preflight green (33/33 verify-msg, 16/16
verify-pack, 8/8 verify-echo, smoke-server 16 tools).

### Files touched

- `src/protocol/midi.ts` — added `MidiPortInfo`, `listMidiPorts()`,
  rewrote the not-found error body.
- `src/server/index.ts` — registered `list_midi_ports` tool.
- `scripts/smoke-server.ts` — added `list_midi_ports` to expected
  tool list + an Inputs/Outputs-structure assertion.
- `docs/STATE.md`, `docs/04-BACKLOG.md` — marked P5-009 items 1 & 2
  as shipped; updated last-session banner.

### What's not done

P5-009 items 3 (startup-banner audit), 4 (README), 5 (Z04-gate
error-message audit after P1-008 lands), and 6 (param-coverage
cheat-sheet) are still open. HW-011 (scene-channel / scene-bypass
captures) still blocks BK-027 phase 2.

---

## 2026-04-19 — Session 24 — BK-027 phase 1 (kitchen-sink `apply_preset`)

**Goal:** let Claude build a multi-channel preset in one MCP call. The
realistic prompt from the Session 22 conversation — *"clean tone on
amp channel A, lead tone on amp channel D, …"* — previously required
~10 round-trips: `apply_preset` to lay out blocks, then a sequence of
channel-switches + `set_params` per channel. With per-slot `channels`
support, the same preset lands in one call.

### Schema change

`slots[i]` gains an optional `channels` field:

```typescript
slots: [{
  position: 1,
  block_type: "amp",
  channels: {
    A: { type: "Deluxe Verb Normal", gain: 3, bass: 5 },
    D: { type: "1959SLP Normal", gain: 8, bass: 6 },
  },
}]
```

Keys are channel letters A/B/C/D (case-insensitive); values are the
same param-name→value maps as the legacy `params` field. Mutually
exclusive with `channel` and `params` on the same slot — validation
surfaces a clear error if a caller combines them. Rejected for blocks
that don't expose channels (compressor, geq, chorus, flanger, phaser,
wah, volpan, tremolo, filter, enhancer, gate, rotary, peq).

### Execution order

Per slot with `channels`:

1. Block-placement write (existing).
2. For each letter in canonical A→B→C→D order that's present in the
   map:
   - Channel-switch write.
   - Param writes in `Object.entries` order for that letter.

Empty channel maps (`channels: { A: {} }`) skip the channel-switch for
that letter — no redundant writes. Missing letters also skip; only
the specified channels are touched. Post-call `lastKnownChannel[block]`
reflects the last channel in the A→B→C→D walk.

### Validation

All validation happens before any MIDI send. Error messages carry a
path prefix so Claude can surface the exact field that failed:

- `slots[0] (position 1, amp) channels.B.gain: amp.gain out of range [0..10]: 12`
- `slots[1] (position 2, compressor): block "compressor" doesn't have channels. Drop the channels field …`
- `slots[0] (position 1, amp) channels.E: must be one of A/B/C/D (case-insensitive), got "E".`

### Testing

Smoke-server (`npm run smoke-server`) gained five validation-path
assertions:

- Mutual exclusion: `channel + channels` combo → rejected.
- Mutual exclusion: `params + channels` combo → rejected.
- `channels` on a non-channel block (compressor) → rejected with
  block-has-no-channels message.
- Unknown channel letter (`E`) → rejected with A/B/C/D enumeration.
- Unknown param inside `channels.A.*` → rejected with path-prefixed
  error.

All five exercise the pre-MIDI validation layer, so the smoke test
still runs without a connected AM4. Full preflight green (33/33
verify-msg, 16/16 verify-pack, 8/8 verify-echo).

### Not in this change

- **Phase 2 (scenes).** `scenes[]` array in `apply_preset` depends on
  HW-011 decoding scene→channel and scene→bypass writes. Tracked in
  backlog; not doable without hardware.
- **Hardware round-trip.** The new shape produces the same primitive
  writes (channel-switch + SET_PARAM) that Session 19 already
  verified on hardware. A combined hardware test — e.g. *"build a
  preset with amp channel A at gain 3 and amp channel D at gain 8"* —
  is queued as **HW-012** so the founder can confirm the orchestration
  end-to-end once the next hardware session runs.

---

## 2026-04-19 — Session 23 — Tool-response trim + unified ack helper

**Goal:** reduce per-tool-call response size in Claude Desktop and unify
the ack-handling helpers. No protocol work, no hardware captures — this
is the lowest-cost release-readiness win now that ack predicates are
stable.

### What changed

- **`sendCommandAndAwaitAck` → `sendAndAwaitAck(conn, bytes, predicate)`**
  generalized to take the ack predicate. One helper for every tool that
  awaits an inbound SysEx ack, regardless of whether the device returns
  the 18-byte `isCommandAck` shape (save / rename) or the 64-byte
  `isWriteEcho` shape (param writes / block placement / scene switch /
  preset switch).
- **`switch_preset` + `switch_scene` now use `isWriteEcho` matching.**
  Per HW-006 / HW-007 the device ack for both is the standard 64-byte
  write-echo. Previously these two tools routed through the legacy
  `sendAndCapture` helper that time-boxed a passive wait and dumped
  every inbound frame to Claude — tens of raw hex bytes per call. With
  predicate-based matching the happy path is a one-sentence verdict;
  hex is preserved on failure for diagnostics.
- **`sendAndCapture` deleted.** Zero remaining callers once the two
  switch tools moved.
- **`set_param` + `set_block_type` success responses trimmed.** Dropped
  the Session-19-era "Sent/Ack/All inbound SysEx" hex blocks on the
  happy path. The blocks were added to debug false-confirm reports;
  after Session 18's echo predicate landed and Session 19's ack-triage
  conclusions settled, they were noise. Ack-less paths still include
  the diagnostic dump because that's when the hex actually helps.

### Effect

Every successful `set_param` call now returns ~280 chars of text
instead of ~800+. `switch_preset` / `switch_scene` drop from ~150–300
chars of raw hex per call to a single verdict sentence. Over a
conversation with 10–20 param writes plus scene/preset switches this
trims Claude Desktop's per-turn token overhead meaningfully — most of
what Claude needs from these tools is "did it ack?", which the new
text answers directly.

### Testing

- `npm run preflight` green (33/33 verify-msg, 16/16 verify-pack,
  8/8 verify-echo, smoke-server all 15 tools).
- No hardware test this session — the predicate-match paths are already
  exercised by the existing `isWriteEcho` goldens for scene switch and
  preset switch (Session 21), and `isCommandAck` was already in use
  for save / rename. The generalization is mechanical.

---

## 2026-04-18 — Session 21 — Scene-switch confirmation, scene-rename map, preset-switch decoded

**Goal:** close three Phase 1 open questions with the hardware captures
the founder queued as HW-001, HW-004, HW-005. All three landed in one
session.

### Captures processed

| Capture | Role |
|---------|------|
| `session-21-switch-scene-1-3-4.pcapng` | HW-001 — switches to scenes 1/3/4 to confirm scene-switch decode |
| `session-22-rename-scene-2.pcapng` | HW-004 — rename scene 2 to "clean" |
| `session-22-rename-scene-3.pcapng` | HW-004 — rename scene 3 to "chorus" |
| `session-22-rename-scene-4.pcapng` | HW-004 — rename scene 4 to "lead" |
| `session-22-switch-preset-via-ui.pcapng` | HW-005 — UI-initiated A01→A02→A01 preset switch |

### 21a — Scene switch confirmed (HW-001)

Session 20 tentatively decoded scene switch from a single capture
(scene 2 = u32 LE value 1 at `pidLow=0x00CE, pidHigh=0x000D`). HW-001
captured all remaining scenes:

| Scene | Packed bytes | Raw u32 LE |
|-------|--------------|-----------|
| 1 | `00 00 00 00 00` | 0 |
| 2 (prior) | `00 40 00 00 00` | 1 |
| 3 | `01 00 00 00 00` | 2 |
| 4 | `01 40 00 00 00` | 3 |

pidHigh is fixed; only the value changes. "value = scene index 0..3"
model confirmed. `buildSwitchScene` unchanged from Session 20; added
three more byte-exact goldens to `verify-msg`.

### 21b — Scene rename pidHigh map (HW-004)

Three renames captured, each a 60-byte command matching the preset-
rename envelope (`action=0x000C`, `hdr4=0x0024`, 36-byte payload) with
different pidHighs:

| Scene | pidHigh | Decoded name |
|-------|---------|--------------|
| 1 (prior) | `0x0037` | *(Session 19g capture)* |
| 2 | `0x0038` | "clean" |
| 3 | `0x0039` | "chorus" |
| 4 | `0x003A` | "lead" |

Pattern: `pidHigh = 0x0037 + sceneIndex` for scenes 0..3. Payload bytes
0..3 (the slot-index field in preset rename) are zeroed — scene names
are working-buffer scoped. `buildSetSceneName(sceneIndex, name)`
landed in `src/protocol/setParam.ts`; `set_scene_name` MCP tool
registered in the server. BK-011 decode complete.

### 21c — Preset switch decoded (HW-005)

`session-22-switch-preset-via-ui.pcapng` captured two unique writes
on the user's A01→A02→A01 click sequence:

| Time | Packed bytes | Unpacked raw (LE) | Interpretation |
|------|--------------|--------------------|----------------|
| t=10.874 | `00 00 10 03 78` | `00 00 80 3F` | float32 = 1.0 (→ A02) |
| t=16.795 | `00 00 00 00 00` | `00 00 00 00` | float32 = 0.0 (→ A01) |

**Preset switch is a `SET_FLOAT_PARAM`** at `pidLow=0x00CE`,
`pidHigh=0x000A`, value = preset location index as **float32**. This
is the first command in the preset-level register family to use
float32 (scene-switch, save-to-slot, and renames all use u32 LE
integers in the payload). Both encodings coexist on the same
`pidLow=0x00CE` register — readers must discriminate by pidHigh.

`buildSwitchPreset(locationIndex)` reuses the existing
`buildSetFloatParam` helper. `switch_preset` MCP tool registered
with a warning in its description about discarding unsaved edits
in the working buffer.

### New MCP tool count

Server now exposes **14 tools** (was 11): added `set_scene_name`,
`switch_preset`, `switch_scene`.

### Preflight

`npm run preflight` green. **33/33 verify-msg goldens match**
(8 new this session: 3 scene switches, 3 scene renames, 2 preset
switches). 8/8 verify-echo green. Smoke-server enumerates all 14
tools.

### What remains

- **HW-002** (preset rename persistence test) still open from prior
  session.
- **HW-003** (save+reload round-trip test) still open.
- **HW-006 / HW-007 / HW-008** (round-trip tests for the three new
  Session 21 tools) queued in `HARDWARE-TASKS.md` for the founder's
  next hardware session.

### Cleanup

- Temp script `scripts/decode-rename-names.ts` (used once to recover
  the three typed-in scene names from packed bytes) deleted after
  goldens landed.

---

## 2026-04-15 — Session 10 — Cache Binary Schema Decoded (Section 1)

**Goal:** turn the 129 KB `effectDefinitions_15_2p0.cache` into a typed
JSON parameter table (`{ id, min, max, default, step, enumValues? }`) so
we can stop hand-curating `KNOWN_PARAMS`.

### The short version

The cache is a byte-packed stream of variable-length records. First
real record at offset `0x36`. Record layout:

```
+0   u16  id
+2   u16  typecode    — 0x1d, 0x2d, 0x37, 0x32, 0x31, 0x35, …
+4   u16  padding
+6   f32  min
+10  f32  max
+14  f32  default
+18  f32  step
+22  payload          — enum list OR 10-byte zero trailer
```

Key finding: **typecode does not determine whether a record carries an
enum**. Both `tc=0x1d` (e.g. "OFF/ON") and `tc=0x2d` (e.g. 130-entry
"CC #1 … OMNI OFF" list) have string enums. The parser detects enums
structurally — read the `u32` count at `+22` and attempt to parse that
many length-prefixed ASCII strings; if they all parse, it's an enum.

Enum payload: `u32 count, count × (u32 len, ASCII bytes)`, then 6-byte
trailer `04 00 00 00 00 00`. Float-range payload: 10-byte zero trailer
(total record size = 32 bytes).

### Section boundary at 0xaa2d

Scanning stops cleanly at a `ff ff 00 00 …` marker (offset `0xaa2d`).
Everything before that marker is **Section 1** — 87 clean records with
monotonically-increasing ids `0x0d..0xa2`. These are global/system
settings (tuner reference frequency, I/O routing mode, MIDI channel,
output level curves, LCD on/off, etc.) — **not block parameters**.

Cache id does **not** map to `pidLow` or `pidHigh`. For example
`amp.level` is `(pidLow=0x3a, pidHigh=0x00)`, but cache id=0 does not
exist in Section 1 and id=0x3a is "MIDI channel" (1..16 + OMNI). No
overlap with Session 08's eight known captured params.

Section 1 parser output: `samples/captured/decoded/cache-records.json`.

### Section 2 (unparsed — next session)

After the `ff ff` marker the file uses a different layout that we
haven't fully cracked:

1. **`0xaa2d..0xb74d`** — a bulk 104-entry preset-name list (A01…Z04,
   including "<EMPTY>" entries). Our speculative parser happens to
   pull it out as one giant "enum" with id=0xffff, tc=0, which is fine
   as a side-effect. The 24-byte preamble between the `ff ff 00 00`
   marker and the count `68 00 00 00` (=104) is still unexplained.

2. **`0xb74d..end`** — repeating 32-byte param definitions with the
   knob_0_10 float pattern (min=0.0, max=1.0, def=10.0, step=0.001)
   and small sequential ids (0, 1, 2, 3, …). These are **per-block
   parameter definitions** — exactly what we need for `KNOWN_PARAMS`.
   Alignment is odd: records are not 4-byte aligned. Each "block"
   probably starts with a header we haven't identified yet.

   First clear record boundary observed at `0xb775` (id=1, knob-type
   float-range). Previous record ends at `0xb774`. Alignment and
   block-header structure is the next session's puzzle.

### What shipped

- `scripts/parse-cache.ts` — 22-byte header decoder, enum auto-detect,
  clean stop at `ff ff` section marker. Parses 87 records (67 enums,
  20 float-range; 3,914 strings recovered from Section 1).
- `scripts/dump-cache-head.ts` — hex+ASCII peek at arbitrary offsets.
  Used for hand-decoding record boundaries.
- `samples/captured/decoded/cache-records.json` — parsed Section 1.

### Next session — decode Section 2

Session 2 in this cache is where the block-parameter metadata actually
lives. The next session should:

1. Start at `0xb74d` and look for a block header (plausibly containing
   block name, block id matching `pidLow`, and param count).
2. Decode the odd-aligned per-param 32-byte records and recover their
   `(pidHigh, min, max, default, step, unit)` tuples.
3. Cross-check against Session 08's eight known `(pidLow, pidHigh)`
   pairs to confirm id ↔ `pidHigh` correspondence per block.
4. Emit a typed `KNOWN_PARAMS`-compatible JSON mapping.

---

## 2026-04-15 — Session 09 — Parameter Metadata Cache Located

**Goal:** find AM4-Edit's parameter metadata (names, ranges, enum values)
so `KNOWN_PARAMS` can be bulk-populated instead of one capture at a time.

### The short version

AM4-Edit stores the entire AM4 parameter metadata — all parameter names,
min/max/default/step values, and enum dropdown strings (amp types, drive
types, reverb types, delay types, cab names, MIDI labels, routing modes,
etc.) — in a single binary cache file:

```
%APPDATA%\Fractal Audio\AM4-Edit\effectDefinitions_15_2p0.cache
```

- `15` encodes the AM4 model byte (matches the known `0x15`).
- `2p0` encodes the firmware version (current AM4 is 2.0).
- Size: **129,320 bytes**.
- Contents: **7,610 length-prefixed ASCII strings** plus floats (ranges,
  defaults, steps) and record headers.

### How we got here

1. **Ghidra string search across `AM4-Edit.exe`** (Session 08 script
   `scripts/ghidra/FindParamTable.java`, output at
   `samples/captured/decoded/ghidra-paramtable.txt`) found **zero hits**
   for `TS808`, `Fat Rat`, `Shred`, and other drive-type names in both
   ASCII and UTF-16LE. The strings aren't in the executable.
2. **Generic labels (`Gain`, `Bass`, `Reverb`, etc.) hit the 50-match
   cap** but were scattered UI / debug strings shared across Fractal's
   entire editor family (Axe-Fx, FM3, FM9, AX8, FX8, AM4). AM4-Edit is
   a generic Fractal editor — it doesn't hardcode AM4-specific data.
3. **Scanning all 11,000+ captured SysEx messages for embedded ASCII**
   produced zero intelligible strings. AM4-Edit does not stream
   metadata over SysEx at runtime.
4. **The install dir has only one candidate sibling file**:
   `english.laxml` — but that's only UI prompts and button labels. The
   decisive clue was an entry inside it:
   ```xml
   <VALUE name="PREFS_DESC_REFRESH_BLOCKDEFS"
     val="... refresh the Block Definitions and all Cab names from the AM4."/>
   ```
5. **Searching `%APPDATA%\Fractal Audio\AM4-Edit\` surfaced the cache.**
   Last-modified timestamp matches the most recent AM4-Edit launch —
   it's refreshed on demand from the device.

### Verified in the cache — drive types, amp types, reverb types, cab names

Every class of AM4 enum string we expected is present. A few examples
out of the 7,610:

- **Drive models:** `Fat Rat`, `Klone Chiron`, `Bender Fuzz`,
  `Shred Distortion`, `Tube Drive 3-Knob`, `Tube Drive 4-Knob`,
  `FAS LED-Drive`, `Horizon Precision Drive`, `MCMLXXXI Drive`,
  `Sonic Drive`, `Hoodoo Drive`, `Shimmer Drive`.
- **Reverb types:** `Plate, Small/Medium/Large/Deluxe/Tube/London/
  Sun/Vocal/Gold`, `Spring, Small/Medium/Large/Deluxe/Tube/Studio/
  Vibrato-King/British`, `Hall, Small/Medium/Large/Concert/
  Large Deep/St. George's Church/St. Albans Cathedral`, `Room, Small/
  Medium/Large/Studio/Recording Studio C/Huge/Drum`.
- **Delay types:** `Dual Delay`, `Reverse Delay`, `Sweep Delay`,
  `Ducking Delay`, `Graphite Copy Delay`, `DM-Two Delay`,
  `Diffused Delay`, `Mono Tape`, `Stereo Tape`, `Lo-Fi Tape`, `Worn Tape`.
- **Amp models:** `5F1 Tweed Champlifier`, `59 Bassguy`, `1959SLP Treble`,
  `1987X Treble`, `Bogfish Strato`, `Princetone Reverb`, many more.
- **Cab IRs:** `1x12 Vibrato Lux`, `1x15 Vibrato Verb`, `2x10 Vibrato Lux`,
  `2x12 Bassbuster`, `4x10 SV Bass`, `8x10 SV Bass`, etc.
- **MIDI:** `CHAN 1` … `CHAN 16`, `CC #1` … `CC #128`, `OMNI`, `OFF/ON`.
- **Routing:** `STEREO`, `SUM L+R`, `COPY L->R`, `SPLIT`, `MUTE`,
  `INVERT`, `NORMAL`, `ANALOG`, `SPDIF`, `USB (CHANNELS 3/4)`.

`samples/captured/decoded/cache-strings.txt` has the full dump
(7,610 lines, offset + string).

### Schema — partially understood

First 16 bytes look like a header: two uint64 LE values = `2, 4`.
Probably (version, flags) or (version, block-count).

After the header, records are variable-sized. Heuristic walker in
`scripts/peek-cache.ts` got clean parses for enum records (first field
= u32 count, then \`(u32 length, ASCII bytes)\` per entry) but the
surrounding struct (id, type code, float ranges) isn't a simple
`[id:u16][len:u16]` stream and the walker desyncs after about 950
records. Proper schema decode is the next session's work.

Observed record shapes that should survive into the real parser:

- **Float-range record:** 24+ bytes. Signature spot-check:
  `[id:u16] 37 00 00 00 00 00 <min:f32> <max:f32> <default:f32>
  <step:f32> <padding>`. Example: the EQ-band-gain records at
  ids 0x11–0x16 all have min=-25.0, max=+25.0, default=1.0, step=0.05.
- **Enum record:** `[id:u16] 1d 00 ... <count:u32> [<len:u32><bytes>]*count`.
  Example: the per-block "input routing" dropdown has four entries
  `Auto In / Auto Out / Manual In / Manual Out`.

### Why this is the bulk-unlock we expected

Once the file parses into a typed map `{ (pidLow, pidHigh) → { name,
min, max, default, step, unit, enumValues? } }`, `KNOWN_PARAMS` becomes
a generated table instead of hand-curated entries. That collapses the
entire "decode parameters one capture at a time" workflow into a single
parser pass, and unblocks:

- Full `PresetIR` (need all block-param names to represent a preset).
- Drive-type / amp-type / reverb-type enum coverage (dropdown strings
  map enum int → display name).
- Natural-language → preset generation (Claude needs parameter
  semantics and value ranges, not just wire addresses).

### Parked for next session

- **Write `scripts/parse-cache.ts`** — full schema decoder. Start from
  the 16-byte header, iterate records, output JSON. Use the known
  enum content (`Auto In / Auto Out / Manual In / Manual Out`) as a
  schema probe: that string list appears at a known offset, so binary-
  search backwards to find the record header shape.
- **Map the cache's `id` field to our `pidHigh`.** The Session 08
  captures give us ground-truth (pidLow, pidHigh) → (name, range) pairs
  for 8 params; if those match cache record IDs 1:1, the cache field
  *is* pidHigh. If it's offset, we'll need to find the mapping.
- **Identify per-block grouping.** The cache is 129 KB; the AM4 has
  tens of blocks; some form of block-id delimiter or per-block section
  almost certainly exists. First glance shows no obvious section marker.

### Files touched this session

- `scripts/ghidra/FindParamTable.java` — Ghidra script (new, committed).
- `samples/captured/decoded/ghidra-paramtable.txt` — 1,151 lines (new).
- `scripts/peek-cache.ts` — cache-walker scratchpad (new, uncommitted).
- `samples/captured/decoded/cache-strings.txt` — 7,610-string dump (new).

---

## 2026-04-15 — Session 08 — Channel Selector Decoded

**Goal:** resolve the Session 07 channel-addressing question with a
targeted capture pair, then extend coverage to all four channels.

### 🟢 Channel select = a regular SET_PARAM write

Captures:
- `samples/captured/session-08-amp-gain-channel-A.pcapng` —
  Amp Gain write on channel A (channel set pre-capture).
- `samples/captured/session-08-amp-gain-channel-B.pcapng` —
  same, on channel B.
- `samples/captured/session-09-channel-toggle.pcapng` — Wireshark running
  first, then user toggles **A → B → A** in AM4-Edit.
- `samples/captured/session-09-channel-toggle-a-c-d-a.pcapng` — same
  shape, toggling **A → C → D → A**.

Findings:

1. **The two Amp-Gain writes on channels A and B are byte-identical.**
   Same pidLow (`0x003A`), same pidHigh (`0x000B`), same action (WRITE),
   same payload. Confirms channel is not encoded in the parameter
   address. Capture-pair interpretation per STATE.md: "identical →
   channel selected by an earlier message."
2. **Channel-toggle captures each contain exactly the expected number
   of WRITE messages** (2 in the A↔B capture at t=11.096s and t=14.479s;
   3 in the A→C→D→A capture). All channel-select writes target
   `pidLow=0x003A, pidHigh=0x07D2`.
3. **Payload = float32 of the channel index.** Running each captured
   5-byte packed suffix through `unpackFloat32LE`:

   | Capture toggle | Suffix bytes | Decoded float |
   |---|---|---|
   | A → B | `00 00 10 03 78` | `1.0` |
   | B → A | `00 00 00 00 00` | `0.0` |
   | A → C | `00 00 00 04 00` | `2.0` |
   | C → D | `00 00 08 04 00` | `3.0` |
   | D → A | `00 00 00 00 00` | `0.0` |

4. **`amp.channel` added to `KNOWN_PARAMS`** with `unit: 'enum'` and
   `enumValues: {0:'A', 1:'B', 2:'C', 3:'D'}`. `verify-msg.ts` gained a
   5th case — `buildSetParam('amp.channel', 1)` produces the exact
   captured channel-B bytes, checksum and all. 5/5 match.

### 🟡 pidHigh septet-decoding correction

The registry edit initially produced the wrong pidHigh (`0x0F52` from
naive LE-byte reading) and `verify-msg.ts` caught it. The two body bytes
at positions 9–10 are **two 7-bit septets of a 14-bit field**, not a
little-endian 16-bit integer. The correct decode is `(hi << 7) | lo`:

- `52 0F` → `(0x0F << 7) | 0x52 = 0x07D2` ✓
- `52 0F` as LE → `0x0F52` ✗ (what parse-capture's body-hex display
  literally shows — it's a diagnostic view, not the decoded field).

Every pidHigh decoded before Session 08 happened to be ≤ `0x7F`, so
both readings produced the same value. Channel was the first pidHigh
where they diverge. Now documented in SYSEX-MAP.md §6a.

### Parked for next session

- **Per-block channel pidHigh confirmation.** The Drive / Reverb / Delay
  channel selectors are probably at `pidHigh=0x07D2` on their respective
  `pidLow`, but not verified. Will come for free when expanding the IR
  to full-preset scope and needing to emit channel writes for those
  blocks.
- **IR structural change.** The working-buffer IR was intentionally not
  extended with a per-block `channel` field — that belongs with the
  full-preset IR expansion (block placement + scenes + channels).
  Channel is accessible via `'amp.channel'` as a plain param for now.
- **Ghidra parameter metadata table** — promoted to "single next action"
  in STATE.md. Unchanged recipe.

---

## 2026-04-14 — Session 07 — Param Registry + Channel-Evidence Mining

**Goal:** ship the typed parameter registry from STATE.md; mine existing
session-06 captures for any channel (A/B/C/D) addressing evidence.

### 🟢 Parameter registry built and hardware-verified

- `src/protocol/params.ts` — `KNOWN_PARAMS` (7 params keyed `block.name`),
  `Unit` union (5 conventions), `encode`/`decode` scale converters.
- `src/protocol/setParam.ts` — added `buildSetParam(key, displayValue)`
  that looks up the param, applies the unit scale, and builds the message.
- `scripts/verify-msg.ts` extended: 4/4 cases pass, including
  `buildSetParam('amp.bass', 6)` matching the `session-06-amp-bass-6`
  captured wire bytes byte-for-byte (envelope, header fields, packed
  float, AND checksum). End-to-end pipeline now closed:
  display value → unit scale → IEEE 754 → 8-to-7 bit-pack → envelope →
  identical to AM4-Edit's wire output.
- Removed obsolete `KNOWN_PARAMS.AMP_GAIN_PRESET_A01` from `setParam.ts`
  (preset-suffix was misleading — addresses are preset-independent).

### 🟡 Channel-addressing question — partial evidence, not conclusive

Mined OUT-direction patterns from `session-06-amp-bass-6.tshark.txt`
(steady-state polling). Findings:

1. **Identical pidHigh values polled across all 4 known blocks** (Amp
   `0x003a`, Reverb `0x0042`, Delay `0x0046`, Drive `0x0076`):
   - `pidHigh=0x0003`, action `0x000d` — ~122× per block
   - `pidHigh=0x0f5d`, action `0x000d` — 28× per block
   - `pidHigh=0x0f66`, action `0x000d` — 268× for Amp (the block being
     edited), 133× for the others
2. **Heuristic:** the high-numbered pidHighs (`0x0f5d`, `0x0f66`) are
   probably **block-level metadata** — bypass state, active channel,
   block-type — not per-parameter values. Heavier polling on the focused
   block matches "UI is showing this block's chrome".
3. **Action codes seen** beyond the now-known `0x0001`/`0x000d`:
   - `0x0026` — high-frequency polling (e.g. `013a000c00260000000000` 32×)
   - `0x0110` — only seen for Amp `pidHigh=0x0009`, 185×. Mystery.
   - `0x010d` — only seen for Amp `pidHigh=0x0009/0x0014/0x0015`. Mystery.
   These don't currently block protocol use; flag and revisit when one
   matters.
4. **Post-write refresh confirmed** — immediately after the bass write
   at t=12.186, AM4-Edit fires action-`0x000d` reads against many Amp
   pidHighs (0x0000, 0x000c, 0x000d, 0x000e, 0x001e, 0x001f, 0x0025,
   0x002c, 0x0062, 0x0063, 0x0f6c, …). This is the **full Amp parameter
   index list** — every value here is a parameter we can name later
   with a targeted single-knob capture.

**Channel question still open.** No channel-switch event in any current
capture. Need: 2 captures with the same parameter (e.g. Amp Gain) edited
once on channel A and once on channel B — diff the OUT messages.
- If the SET_PARAM bytes are identical → channel is selected via a
  separate message (probably one of the 0x0110/0x010d mysteries).
- If they differ → there's a channel offset baked into pidLow or pidHigh.

### 🟢 Preset IR + transpiler scaffolding

- `src/ir/preset.ts` — minimal `WorkingBufferIR` (flat param map only).
- `src/ir/transpile.ts` — `transpile(ir)` → ordered `number[][]` of
  SET_PARAM messages, one per param entry, insertion-order preserved.
- `scripts/verify-transpile.ts` — round-trips a 3-param IR and confirms
  each emitted message equals `buildSetParam(key, value)`.

Scenes, channels, block placement deferred until protocol RE catches up.

---

## 2026-04-14 — Session 04 — USB Capture of AM4-Edit's `0x01` Param-Set Command

**Device / firmware:** AM4 f/w 2.00, same setup. AM4-Edit v1.00.04.
**Approach:** USBPcap + Wireshark at the USB kernel level (the loopMIDI
sniffer from Session 02 was blocked by AM4-Edit's virtual-port filter).
Parser: `scripts/parse-capture.ts` reads a `tshark -V -Y sysex` dump of
the pcapng and bucketises OUT SysEx by body pattern.

### Setup troubleshooting (one-time, keep this for future USB captures)

1. USBPcap installed standalone → Wireshark's interface list didn't show
   USBPcap interfaces. Fix: **copy `C:\Program Files\USBPcap\USBPcapCMD.exe`
   into `C:\Program Files\Wireshark\extcap\`** (needs elevation). Wireshark
   re-installer with "USBPcap" checkbox does the same thing but is fiddlier
   when USBPcap is already installed.
2. **Wireshark must run as Administrator** — extcap won't enumerate USBPcap
   interfaces without elevation.
3. A Windows reboot is required once, to load the USBPcap kernel driver
   after install. `sc query USBPcap` should show `STATE : 4 RUNNING`.
4. On this ThinkPad, the AM4 enumerates on the same root hub as the
   fingerprint reader → **USBPcap2**.

### Files captured (in `samples/captured/`)

| File | What | Writes found |
|------|------|--------------|
| `capture_1.pcapng` | Exploratory; physical knob moved. AM4-Edit only polled. | 0 |
| `session-04-gain-3-to-4.pcapng` | Gain field typed 4.00 + Enter in AM4-Edit. | 1 |
| `session-04-gain-ladder.pcapng` | Ladder 1/2/3/4 typed in sequence. | 4 |
| `session-04-gain-ladder2.pcapng` | Ladder repeat to verify determinism. | 4 (identical bytes) |
| `session-04-gain-float-validation.pcapng` | 0.25 / 0.50 / 1.50 / 2.50 to test float hypothesis. | 4 |

Paired `.tshark.txt` dumps live in `samples/captured/decoded/`.

### 🟢 Write-command shape confirmed

AM4-Edit's parameter-set command uses **function byte `0x01`** (not `0x02`
as the Axe-Fx II template suggested — see retraction below).

```
F0 00 01 74 15 01 [addr:4] [action:1] 00 00 00 [len:1] [value:6] [cs] F7
```

| Bytes | Meaning | Read example | Write example |
|---|---|---|---|
| 0–4 | Envelope | `F0 00 01 74 15` | `F0 00 01 74 15` |
| 5 | Function | `01` | `01` |
| 6–9 | Parameter address (4 bytes) | `3A 00 0B 00` | `3A 00 0B 00` |
| 10 | **Action code** | `26` / `0D` / `10` / `1F` / `0E` (read-by-type) | **`01` (WRITE)** |
| 11–13 | Reserved | `00 00 00` | `00 00 00` |
| 14 | Payload length (raw) | `00` | `04` (4 raw bytes) |
| 15–20 | Payload (SysEx-packed) | *(none)* | 6 7-bit bytes |
| 21 | Checksum | ✓ | ✓ |
| 22 | End | `F7` | `F7` |

- OUT reads are 18 bytes (payload length byte = 0, no value data).
- OUT writes are 23 bytes (payload length byte = 4, 6 value bytes follow).
- Every 23-byte OUT in every capture is a write. Every 18-byte OUT is a read.
- 3,499 reads vs 1 write in the single-value capture → AM4-Edit polls
  ~200×/s and writes only on Enter-commit. Typing alone doesn't write.

### 🟡 Value encoding — 32-bit IEEE 754 float, packing scheme TBD

The 6-byte `[value]` field carries a 32-bit IEEE 754 float packed into
6 SysEx-safe 7-bit bytes (4 × 8 = 32 bits of data in 6 × 7 = 42 wire bits,
leaving 10 overhead bits). Evidence:

| Gain | Float32 | Mantissa | Wire bytes 15–20 |
|------|---------|----------|------------------|
| 0.25 | `3E 80 00 00` | 0 | `00 66 73 19 43 60` |
| 0.50 | `3F 00 00 00` | 0 | `00 66 73 09 43 68` |
| 1.00 | `3F 80 00 00` | 0 | `00 66 73 19 43 68` |
| 1.50 | `3F C0 00 00` | ≠0 | `00 4D 26 23 13 70` |
| 2.00 | `40 00 00 00` | 0 | `00 66 73 09 43 70` |
| 2.50 | `40 20 00 00` | ≠0 | `00 00 00 10 03 70` |
| 3.00 | `40 40 00 00` | ≠0 | `00 4D 26 33 13 70` |
| 4.00 | `40 80 00 00` | 0 | `00 66 73 19 43 70` |

All zero-mantissa values share the `00 66 73 XX 43 XX` skeleton and only
differ in bytes 18 and 20. Non-zero-mantissa values break this skeleton
entirely — exactly the prediction the float hypothesis makes, since only
zero-mantissa floats have three zero bytes in their IEEE layout. The
exact packing (probably a Fractal-family bit-pack like the Axe-Fx III
"3-septet-per-byte" scheme — see §10b of `SYSEX-MAP.md`) is not yet
decoded; 8 samples may be enough to brute-force it.

### 🟢 Amp Gain parameter address (preset A01)

`3A 00 0B 00` — 4-byte parameter address, appears in both reads and the
matched write. Assumed stable across presets for the Amp block's Gain
knob, but only verified on A01 at the moment.

### 🟢 Read action codes (partial)

The byte at position 10 selects the kind of read the host wants back:

| Code | Response size | Observed for |
|------|---------------|--------------|
| `0D` | 64 B | Common block-data reads (34 B body) |
| `10` | 64 B | Alternate block-data reads |
| `1F` | — | Infrequent; one address family |
| `26` | 34 B | Poll of a short parameter (reads for `3A 00 0B`) |
| `0E` | 34 B | Used for `4E 01 7X` address family |

Full table will shake out as more parameters get captured.

### Retractions

- **SYSEX-MAP §5 `0x01 GET_BLOCK_PARAMETERS_LIST` (Axe-Fx II) — retracted
  as the AM4 meaning.** AM4's `0x01` is a generic per-parameter
  read/write dispatcher with action codes at body-byte 5, not a
  "list block parameters" command.
- **SYSEX-MAP §5 `0x02 GET/SET_BLOCK_PARAMETER_VALUE` as "P0 live-tweak
  MVP" — retracted as the AM4 function byte.** AM4-Edit uses `0x01` for
  live parameter writes, not `0x02`. `0x02` remains unverified on AM4.

### Next session plan (Session 05)

1. **Decode the 6-byte packing.** Try common Fractal/Roland schemes
   against the 8 known samples (likely a 5-bytes-of-data + 1-MSB-carrier
   variant with padding, or the 3-septet-per-byte bit-pack the III uses).
   Write `scripts/decode-float-pack.ts` to search the scheme space.
2. **Build `scripts/write-test.ts`** — a one-shot script that sends a
   single real param-set write for Amp Gain on slot **Z04 only** (per
   the write-safety rules in `DECISIONS.md`), then reads back to verify.
3. **Capture one more parameter** (e.g. Amp Bass) at three known values
   to see whether the encoding is parameter-agnostic float or per-type.

---

## 2026-04-14 — Session 03 — Preset `.syx` Export Analysis

**Device / firmware:** AM4 f/w 2.00, same setup. AM4-Edit v1.00.04.
**Approach:** instead of live-sniffing AM4-Edit (blocked by port filtering), we
exported preset `.syx` files directly from AM4-Edit's Save-As feature and
analyzed the file format.

### Files captured

In `samples/factory/`:
- `A01-original.syx` — preset A01, Amp Gain = 3.00 (12,352 B)
- `A01-gain-plus-1.syx` — same preset, Amp Gain = 4.00 (12,352 B)
- `A01-clean-a.syx` / `A01-clean-b.syx` — two back-to-back exports, no edits (12,352 B each)
- `AM4-Factory-Presets-1p01.syx` — Fractal's full factory bank, 104 presets (1,284,608 B)

### Findings

**🟢 File structure (12,352 B single-preset dump):**

| Msg | Offset | Size | Function | Role |
|-----|--------|------|----------|------|
| 1 | 0 | 13 B | `0x77` | PRESET_DUMP_HEADER |
| 2–5 | 13, 3095, 6177, 9259 | 3082 B × 4 | `0x78` | PRESET_DUMP_CHUNK |
| 6 | 12341 | 11 B | `0x79` | PRESET_DUMP_FOOTER |

**🟢 Slot encoding decoded** — from factory bank headers:

```
[A01] F0 00 01 74 15 77 00 00 00 20 00 47 F7   bank=0  slot=0
[A02] F0 00 01 74 15 77 00 01 00 20 00 46 F7   bank=0  slot=1
[B01] F0 00 01 74 15 77 01 00 00 20 00 46 F7   bank=1  slot=0
```

- **Byte 6** = bank index, 0x00–0x19 (A–Z)
- **Byte 7** = slot within bank, 0x00–0x03
- **Byte 8–10** = `00 20 00` (fixed; probably size/version marker)
- **Byte 11** = envelope checksum

User exports use `7F 00` in bytes 6–7 as a "current working buffer" sentinel
(matches the `0x7F` query sentinel elsewhere in Axe-Fx III 3rd-party protocol).
When we write a preset to slot Z04, bytes 6–7 must be `19 03`.

**🟢 Chunk prefix** — every `0x78` message starts with identical 14 bytes:
```
F0 00 01 74 15 78 00 08 07 02 00 55 54 02
```
Envelope (6) + fixed chunk header (8).  Payload region is byte 15 onwards.

**🟢 Chunks 4 & 5 are shared padding** — identical across all presets in the
factory bank AND across all user exports. 6,164 bytes out of 12,352 are dead
space (block slots unused by the preset, zero-initialized but position-wise
fixed). All meaningful preset data lives in chunks 2 & 3.

**🔴 Chunks 2 & 3 are per-export scrambled.** Two clean exports of the SAME
preset with zero edits show ~2,732 differing bytes. Factory A01 vs factory A02
show ~2,612 + 1,103 differing bytes. The magnitudes are similar whether
comparing same-preset-different-export, same-preset-different-edit, or
different-presets — which means simple byte-diffing CANNOT locate a parameter
value in chunks 2–3.

Likely scrambling mechanism: **MIDI 7-bit safe encoding + per-export
random/session padding**. Forum research
([forum.fractalaudio.com](https://forum.fractalaudio.com/threads/axe-fx-iii-and-deconstructing-parsing-a-syx-sysex-preset-file.159885/))
indicates Axe-Fx III uses 3-septet-per-byte bit-packing with names split
across bytes. AM4 presumably inherits this. Format has NOT been publicly
cracked by the community.

### Strategic pivot

Attacking the binary format directly is weeks of work with uncertain payoff.
Instead we pivot to a different architecture: **puppet the device**. AM4-Edit
doesn't construct preset binaries in-memory either — it uses the device's
live editor protocol (function `0x01`) to set parameters on the working
buffer, then issues the store command (`0x77/0x78/0x79`) to persist. We do
the same programmatically.

This requires reverse-engineering AM4-Edit's outgoing `0x01` command shape,
which the loopMIDI-based sniffer couldn't capture (AM4-Edit rejects virtual
ports). Next step: USBPcap + Wireshark to capture at the USB kernel level.

### Retractions

- No retractions from prior sessions.

### Next session plan (Session 04)

1. Capture a Wireshark trace of AM4-Edit changing one parameter (Amp Gain +1).
2. Extract AM4-Edit's outgoing SysEx messages and AM4's responses.
3. Decode the `0x01` parameter-set command format.
4. Write a proof-of-concept "set parameter" function using the sniffed format.
5. Combine with the already-decoded `0x77/0x78/0x79` store command to persist
   a configured preset.

---

## 2026-04-14 — Session 02 — Axe-Fx III Protocol Confirmed

**Device / firmware:** AM4, firmware 2.00, same USB/driver setup.
**Script:** `scripts/probe.ts` after swapping Axe-Fx II guesses for Axe-Fx III opcodes (0x0C, 0x0D, 0x0E, 0x13, 0x14 query forms).
**Primary source consulted between sessions:** `docs/manuals/AxeFx3-MIDI-3rdParty.txt` (official Fractal PDF, text-extracted).

### Raw capture (trimmed to new probes)

```
→ F0 00 01 74 15 0C 7F 63 F7                            [Q_SCENE query]
← F0 00 01 74 15 0C 00 1C F7                            [scene 0 = displayed as 1]

→ F0 00 01 74 15 0D 7F 7F 1D F7                         [Q_PATCH_NAME query]
← F0 00 01 74 15 0D 03 52 [32 × 0x00] 4C F7             [preset id 03 52, empty name]

→ F0 00 01 74 15 0E 7F 61 F7                            [Q_SCENE_NAME query]
← F0 00 01 74 15 0E 00 [32 bytes mostly 0, with 10 43 30 stray] 7D F7
                                                         [scene 0, name field looks uninitialised]

→ F0 00 01 74 15 14 7F 7F 04 F7                         [Q_TEMPO query]
← F0 00 01 74 15 14 60 5B 3F F7                         [raw 11744; probably BPM × 100 = 117.44]

→ F0 00 01 74 15 13 03 F7                               [STATUS_DUMP]
← F0 00 01 74 15 13 25 00 46 | 2A 00 46 | 3E 00 44 | 4E 01 10 | 29 F7
                              ↑ 4 three-byte packets (id id dd per Axe-Fx III spec)
```

### Decoded STATUS_DUMP packets

| Packet | ID (dec) | Axe-Fx III enum | dd (bin) | Bypass | Channel | Ch count |
|--------|----------|-----------------|----------|--------|---------|----------|
| 1 | 37 | ID_INPUT1 | 01000110 | engaged | D (3) | 4 |
| 2 | 42 | ID_OUTPUT1 | 01000110 | engaged | D (3) | 4 |
| 3 | 62 | ID_CAB1 | 01000100 | engaged | C (2) | 4 |
| 4 | **206** | _beyond Axe-Fx III public enum_ | 00010000 | engaged | A (0) | 1 |

### Key findings

| Claim | Confidence | Evidence |
|-------|------------|----------|
| AM4 follows Axe-Fx III 3rd-party MIDI spec | 🟢 confirmed | Every III opcode returned structured data, not rc=0x05 NACK |
| Block IDs use Axe-Fx III enum (IDs ≥ 37) | 🟢 confirmed | 37/42/62 match ID_INPUT1/OUTPUT1/CAB1 exactly |
| AM4 extends the III enum above 200 | 🟡 inferred | ID 206 appears in STATUS_DUMP, not in the public enum; most likely the Amp block |
| AMP on AM4 has a single "channel" | 🟡 inferred | Packet 4 reports 1 channel; consistent with "pick-one-of-437-amp-models" rather than A/B/C/D |
| Axe-Fx II opcodes are NOT accepted | 🟢 confirmed (session 01 + this session) | 0x02 with all six guessed block IDs → rc=0x05 |
| Current preset has no name | 🟢 confirmed | 32 null bytes in 0x0D response |
| "Preset 0 = A01" claim from Session 01 | 🔴 **retracted** | 0x14 on AM4 is TEMPO, not GET_PRESET_NUMBER |

### Retractions from Session 01

- `0x14` was misinterpreted as GET_PRESET_NUMBER (Axe-Fx II meaning). On AM4 it is SET/GET_TEMPO. The `00 00` payload from session 01 was a malformed query (no `7F 7F` payload) returning a default/zero value, not a preset index.
- `0x0F` was not "AM4-specific preset-name query candidate." It's the Axe-Fx II GET_PRESET_NAME, which AM4 correctly rejects. The real command is `0x0D` QUERY PATCH NAME per the Axe-Fx III spec.

### Side observations

- The `0x64` MULTIPURPOSE_RESPONSE NACK pattern is NOT present in the Axe-Fx III 3rd-party spec — yet AM4 uses it for rejected commands. So AM4's NACK behavior is a superset/blend of the two families.
- Response checksums are uniformly present. No `0x0D TUNER_INFO` equivalent observed (tuner wasn't active).

### Next session plan — shifts significantly

Per the project owner's scope direction (MVP = preset authoring, not live control), the
next step is **NOT** testing `0x0A`/`0x0B` bypass/channel writes. Instead:

1. Install MIDI-OX. Sniff AM4-Edit performing these four workflows, and
   capture raw SysEx for each:
   - Load a factory preset from device to AM4-Edit (preset DUMP OUT)
   - Push a modified preset from AM4-Edit to the device (preset DUMP IN — this is the STORE command we need)
   - Change one parameter (e.g., Amp gain from 5 to 6) and observe the delta messages
   - Save the modified preset back to its slot
2. From (1b), identify the preset upload opcode and byte layout.
3. From (1c) / (1d), begin the parameter-locate diff work in `scripts/diff-syx.ts`.
4. Set up slot **Z04** as the permanent scratch slot — document in `DECISIONS.md`
   (done) and reference in every future write test.

---

## 2026-04-14 — Session 01 — First Probe

**Device:** Fractal AM4, firmware v2.00 (build Mar 20 2026 06:46:54),
direct USB to Windows ThinkPad, Fractal driver installed.
**Script:** `scripts/probe.ts` (commit after `ignoreTypes(false, true, true)` fix).
**Tools:** no AM4-Edit, no MIDI-OX — just our probe.

### Goal
Confirm basic two-way communication and test whether Axe-Fx II/AX8
function IDs work on AM4 as first-guess templates.

### Raw capture

```
→ F0 00 01 74 15 12 49 4B F7                           [SCENES_MODE]
← F0 00 01 74 15 64 12 00 66 F7                        [ACK fn=0x12 rc=0x00]

→ F0 00 01 74 15 08 18 F7                              [GET_FIRMWARE_VERSION]
← F0 00 01 74 15 08 02 00 03 04 05 00 00
  4D 61 72 20 32 30 20 32 30 32 36 20 30 36 3A 34 36 3A 35 34
  00 00 00 00 00 00 00 00 00 00 00 00 67 F7            [firmware v2.00 + build date]

→ F0 00 01 74 15 0F 1F F7                              [GET_PRESET_NAME]
← F0 00 01 74 15 64 0F 05 7E F7                        [ACK fn=0x0F rc=0x05 — REJECTED]

→ F0 00 01 74 15 14 04 F7                              [GET_PRESET_NUMBER]
← F0 00 01 74 15 14 00 00 04 F7                        [preset 0 = A01]
```

### Decoded findings

| Message | Meaning | Confidence |
|---------|---------|------------|
| `0x64` MULTIPURPOSE_RESPONSE format | `[echoed_fn, result_code]` same as Axe-Fx II | 🟢 confirmed |
| Result code `0x00` | OK | 🟢 confirmed on `0x12` |
| Result code `0x05` | Parsed but not honored | 🟢 confirmed on `0x0F` |
| `0x08` GET_FIRMWARE_VERSION | Works. Extended format: Axe-Fx II prefix (MAJ MIN + 5 reserved) then null-terminated ASCII build date | 🟢 confirmed |
| `0x14` GET_PRESET_NUMBER | Works. Two-byte 14-bit value, payload `00 00` = preset 0 (A01) | 🟢 confirmed |
| `0x0F` GET_PRESET_NAME | Rejected with rc=0x05. AM4 uses a different mechanism for this | 🔴 needs sniffing |
| All responses carry checksums | Simpler than Axe-Fx II's split | 🟢 confirmed (small sample) |
| Envelope / checksum / model ID 0x15 | Match expectations | 🟢 confirmed |

### Side observations

- AM4 reportedly jumped to scene 3 after the mode switch. Hypothesis:
  device remembers last-selected scene per preset; scene-mode entry
  just displays it. Not a side effect of any command sent. To confirm:
  manually select scene 1, exit scene mode, re-run probe.
- `node-midi` requires `input.ignoreTypes(false, true, true)` before
  `openPort()` or it silently drops all SysEx. First probe run produced
  zero responses for exactly this reason. Documented in probe.ts.

### Next session plan

1. **Find the real preset-name query.** Probe candidates in this order:
   - `0x0E` PRESET_BLOCKS_DATA (may carry name as part of block list)
   - `0x09` (Axe-Fx II SET_PRESET_NAME — may be dual-purpose on AM4)
   - Scan `0x30`–`0x50` for any function ID that returns name-shaped data
   - If nothing surfaces, open AM4-Edit with MIDI-OX and watch what
     query it uses when loading a preset
2. **Test `0x02` GET_BLOCK_PARAMETER_VALUE** with a guessed block ID
   (106 = Amp 1 from Axe-Fx II). Query mode (`M=0x00`) on parameter 0.
   If rc=0x00 comes back with a label string, we have the live-tweak MVP
   unblocked. If rc=0x05, swap block ID and retry.
3. **Test `0x3C` SET_PRESET_NUMBER** to switch to a different preset.
   Audible confirmation: preset name visible on device display.
4. **Test `0x29` GET_SCENE_NUMBER**. Expect a two-byte scene index
   response (0–3 on AM4).
