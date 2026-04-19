# User Prompt Coverage

Living reference mapping realistic user prompts to the minimum tool-call
sequence that satisfies each one. Used to audit that the tool surface
matches expected usage patterns, and to flag gaps before a user hits them.

Each row shows the **target** minimum-call path (post all queued backlog
work); the "today" path is often larger. When tools ship or decodes land,
update the affected rows.

## Status legend

- ✅ **Works today.** Minimum-call path available; all tools shipped.
- ⚠ **Path known, blocked on backlog.** Listed items must land first.
- ❌ **Research / decode required.** Gap in the protocol map; needs new
  captures or a decode we haven't planned yet.

## Performance budget (from CLAUDE.md)

- **Ideal:** < 200 ms (1 wire transaction — ~50 ms SysEx round-trip +
  MCP overhead)
- **Acceptable:** < 1 s (2–5 wire transactions in a single MCP call)
- **Warn user upfront:** 1–5 s (many wire transactions, single MCP call)
- **Avoid altogether:** > 5 s in a single call, OR > 5 separate MCP calls
  chained (each chained call adds LLM-generation latency ~2–4 s)

Single-MCP-call latency ≈ (wire_count × 50 ms) + MCP overhead.
Chained-MCP-call latency ≈ single-call latency + (chain_length × ~3 s
LLM-generation per link).

---

## Surgical edits (single param / narrow change)

| Prompt | Minimum path | Wire | Latency | Status |
|---|---|---|---|---|
| *"Change amp gain to 5"* | 1 × `set_param` | 1 | ~150 ms | ✅ |
| *"More low end on the drive"* | 1 × `set_param drive.*` | 1 | ~150 ms | ✅ |
| *"Set reverb mix to 30 and delay time to 400 ms"* | 1 × `set_params` (2 writes) | 2 | ~250 ms | ✅ |
| *"Boost the mids"* | 1 × `set_param amp.mid` | 1 | ~150 ms | ⚠ P1-010 — `amp.mid` not yet in `KNOWN_PARAMS` (one of the hallucination examples) |
| *"Set the amp to a Marshall JCM800"* | 1 × `set_param amp.type` | 1 | ~150 ms | ✅ (amp.type enum covers all 248 models) |
| *"Swap the reverb for a delay"* | 1 × `set_block_type` | 1 | ~150 ms | ✅ |
| *"Add a compressor before the amp"* | 1–2 × `set_block_type` | 1–2 | ~250 ms | ✅ |
| *"Give me more feedback on the delay"* | 1 × `set_param delay.feedback` | 1 | ~150 ms | ⚠ P1-010 — `delay.feedback` not yet in registry |

## Multi-channel / scene-aware edits

| Prompt | Minimum path | Wire | Latency | Status |
|---|---|---|---|---|
| *"Change amp gain to 6 on channel B"* | 1 × `set_param(channel: "B")` | 2 (switch + write) | ~200 ms | ✅ Shipped session 22 |
| *"Configure channel A with gain 3, channel B with gain 6"* | 1 × `set_params` with per-write `channel` | 4 (2 switch + 2 write) | ~300 ms | ✅ Shipped session 22 |
| *"Change amp gain on scene 2"* | 1 × `set_param` with scene→channel lookup | 2–3 | ~250 ms | ⚠ Requires HW-011 + BK-025 decode (Claude needs to know scene 2's channel for Amp before picking which channel to target) |
| *"Make scene 2 bypass the reverb"* | 1 × scene-bypass write | 1 | ~150 ms | ⚠ HW-011 decode (scene→bypass register) |
| *"Point scene 3 at amp channel C"* | 1 × scene-channel write | 1 | ~150 ms | ⚠ HW-011 decode (scene→channel register) |

## Preset composition (single preset from scratch)

| Prompt | Minimum path | Wire | Latency | Status |
|---|---|---|---|---|
| *"Build a clean preset with comp/amp/delay/reverb"* | 1 × `apply_preset` | ~10 | ~600 ms | ✅ |
| *"Build the above with amp gain 6, delay 350 ms, reverb mix 30"* | 1 × `apply_preset` (with params) | ~13 | ~800 ms | ✅ |
| *"Set up all 4 amp channels with different types and gains"* | 1 × `apply_preset` with `slots[i].channels` | ~20 | ~1.1 s | ⚠ BK-027 phase 1 (kitchen-sink apply_preset, no new decodes — shippable now) |
| *"Build a preset with clean/crunch/rhythm/solo scenes on channels A/B/C/D"* | 1 × `apply_preset` kitchen-sink | ~40–60 | ~2.5 s (warn user) | ⚠ BK-027 phase 2 + HW-011 (scene→channel + scene→bypass decodes) |
| *"Copy preset A03 and tweak the reverb"* | 1 × `switch_preset` + 1 × `set_param` + 1 × `save_preset` | 3 | ~500 ms chained (3 MCP calls × ~3 s LLM-gen ≈ ~10 s total) | ⚠ Chain length crosses the 5-MCP-call warning threshold; tolerable but not great |

## Persistence

| Prompt | Minimum path | Wire | Latency | Status |
|---|---|---|---|---|
| *"Save to Z04"* | 1 × `save_to_location` | 1 | ~150 ms | ✅ (Z04-gated until P1-008) |
| *"Save this as 'Clean Machine'"* | 1 × `save_preset(Z04, name)` | 2 | ~250 ms | ✅ Shipped session 22 |
| *"Save to A05"* (target is a user preset) | 1 × `save_preset(A05, name, force: true)` | ~3 (backup + rename + save) | ~450 ms | ⚠ P1-008 (tiered write gate + auto-backup + force flag) |
| *"Overwrite the factory preset at B02"* | 1 × `save_preset(B02, name, force: true)` | ~3 | ~450 ms | ⚠ P1-008 (factory tier + mandatory confirmation framing) |

## Navigation

| Prompt | Minimum path | Wire | Latency | Status |
|---|---|---|---|---|
| *"Switch to B03"* | 1 × `switch_preset` | 1 | ~150 ms | ✅ |
| *"Switch to scene 3"* | 1 × `switch_scene` | 1 | ~150 ms | ✅ |
| *"Go back to what I was on"* | Needs server-tracked history | 1 | ~150 ms | ❌ No history cache yet — cheap to add if wanted |

## Inspection (read state from device)

| Prompt | Minimum path | Wire | Latency | Status |
|---|---|---|---|---|
| *"What preset am I on?"* | Parse next `switch_preset` ack, OR new read tool | 0–1 | 0–150 ms | ❌ BK-026 (preset-switch ack payload decode) OR the parked READ-response format |
| *"What's my current amp gain?"* | Parse SET_PARAM ack payload OR new read | 0–1 | ~150 ms | ❌ BK-008 (40-byte write-ack payload) still undecoded |
| *"What channel is the amp on?"* | Server-tracked cache (Shape 1) | 0 | ~0 ms | ⚠ Shipped today with caveats — reports "last explicitly set" or "unknown this session." Authoritative answer needs BK-025 |
| *"What's in scene 2?"* | Parse scene-switch ack payload | 1 (switch + switch back) | ~200 ms | ❌ BK-025 (scene-switch ack decode) |
| *"What blocks are in the current preset?"* | Parse preset-switch ack OR explicit read | 0–1 | ~150 ms | ❌ BK-026 |

## Research / knowledge lookups

| Prompt | Minimum path | Wire | Latency | Status |
|---|---|---|---|---|
| *"What's the Vox AC30 equivalent in the AM4?"* | 1 × `lookup_lineage(amp, real_gear: "AC30")` | 0 | ~100 ms | ✅ |
| *"What tones is Cantrell known for?"* | 1 × `lookup_lineage(real_gear: "Cantrell")` | 0 | ~100 ms | ✅ |
| *"List my amp options"* | 1 × `list_enum_values("amp.type")` | 0 | ~100 ms | ✅ |
| *"What params can I set on the drive?"* | 1 × `list_params` (filter client-side) | 0 | ~100 ms | ⚠ Response accuracy depends on P1-010 coverage (today: 3 drive params registered; ~50 exposed by AM4) |
| *"What's an LA-2A-style compressor?"* | 1 × `lookup_lineage(compressor, real_gear: "LA-2A")` | 0 | ~100 ms | ✅ |

## Batch workflows

| Prompt | Minimum path | Wire | Latency | Status |
|---|---|---|---|---|
| *"Build 10 presets from this setlist and save them"* | 1 × `build_and_save_presets` | ~600 | 30–45 s (warn user upfront) | ⚠ BK-027 phase 1 + P1-008 + BK-028 |
| *"Build 16 presets for my gig"* | Same tool, bigger batch | ~960 | 50–75 s | Same blockers |
| *"Build per-song presets for this album's tracklist"* | Research (Claude) → `build_and_save_presets` | ~600+ | Research-dominated; wire similar to above | Same blockers |
| *"Batch-rename presets A01–A04"* | 1 × bulk-rename (does NOT exist yet) | ~8 | ~500 ms | ❌ No tool today; 4 × `save_preset` chain works (⚠ ~15 s with MCP overhead) |

## Connection / reliability

| Prompt | Minimum path | Wire | Latency | Status |
|---|---|---|---|---|
| *"Reconnect the AM4"* | 1 × `reconnect_midi` | 0 | ~100 ms | ✅ |
| *"Writes aren't working anymore"* | `reconnect_midi` → retry | 0 + retry | varies | ✅ Auto-reconnect after 2 consecutive ack-less writes also built in |
| *"The AM4 isn't connected"* | Clear error message from any tool call | 0 | ~100 ms | ✅ Shipped Session 25 — error lists common causes (USB / driver / AM4-Edit exclusivity) and points at `list_midi_ports` + `reconnect_midi` |
| *"What MIDI devices does the server see?"* / *"Is the AM4 visible?"* | 1 × `list_midi_ports` | 0 | ~10 ms | ✅ Shipped Session 25 — enumerates every MIDI input/output without opening the AM4 connection |

---

## Gaps not covered by any prompt yet

Things users *might* ask that have no path — worth flagging because each
represents either a backlog item we haven't written or a product decision
we haven't made.

- **Modifier / controller assignments** ("make reverb mix track the
  expression pedal"). The Controller block in the AM4 does this, but
  it's undecoded. No captures, no tool, no backlog item. Probably
  post-MVP.
- **Preset copy / move** ("copy A03 to W01" or "move my current
  working buffer to W05 without renaming"). Composable today from
  `switch_preset` + `save_to_location` but not a named flow. Cheap
  backlog item when the use case shows up.
- **Undo / backup restore.** P1-008 ships backups; a
  `restore_location(location, backup_id?)` tool is spec'd but not
  shipped. "Undo my last save" maps to the most recent backup for
  that location.
- **A/B tone comparison** ("compare preset A03 to A04"). Needs two
  reads (BK-026) + presentation layer. Post-MVP.
- **Audition / preview without saving** ("let me hear this tone").
  Already works implicitly — apply_preset hits the working buffer,
  user hears it, nothing is persisted unless they save. But there's
  no explicit "revert to what I had before" tool short of
  `switch_preset` to a saved location.

---

## When to update this file

- Every time a tool ships: flip the affected rows from ⚠ to ✅.
- Every time a decode lands (BK-025, BK-026, BK-008, HW-011): flip
  affected rows from ❌ to ⚠ or ✅.
- When a founder test session surfaces a new prompt pattern: add a
  row and classify its status.
- When a backlog item is retired or re-scoped: update the "Status"
  column references.

Not a release gate in itself — but the release gate in
`LAUNCH-POST-OUTLINE.md` transitively covers this file via the
backlog items referenced in each row's status. Consult this file
during founder testing to verify coverage.
