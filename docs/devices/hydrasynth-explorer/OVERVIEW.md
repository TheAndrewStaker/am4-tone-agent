# Hydrasynth Explorer — Overview

## The device

ASM Hydrasynth Explorer. Keytar form factor (the scaled-down sibling
of the Hydrasynth Keyboard / Desktop / Deluxe). Same synthesis engine
as its larger siblings:

- 8 voices.
- 3 oscillators per voice (Osc 1 + 2 with Wave Morph + WaveScan; Osc 3
  simpler).
- 2 filters (per-voice, configurable in series or parallel).
- 5 envelopes, 5 LFOs.
- 4 Mutators (FM / ring-mod / wavefolder / phase-mod variants per slot).
- 8 Macros, 32-slot mod matrix.
- Onboard arp + Pre-FX + Delay + Reverb + Post-FX.
- Mono USB MIDI (class-compliant, no driver install) + 5-pin MIDI
  In/Out + CV/Gate/Clock outs.

Single-patch only (no multi-patch like the Deluxe). 8 banks A–H × 128
patches.

## Why we care

Founder owns the device as of 2026-04-25 (replaces the JD-Xi in their
collection). Adds a synth alongside the Fractal amp modeller so the
project covers more than guitar gear. Synthesis is also the founder's
first deep dive into the topic from a guitar background — tool
descriptions for this device will lean pedagogical.

## Protocol surface (what the manual gives us)

Source: `docs/manuals/other-gear/Hydrasynth_Explorer_Owners_Manual_2.2.0.pdf`,
"MIDI" section pp. 80–83 + "MIDI CC Charts" pp. 94–96.

| Channel | Status | What's available |
|---|---|---|
| **System CCs** (always on) | 🟢 documented | CC 0/32 Bank Select MSB/LSB, CC 1 Mod Wheel, CC 7 Master Volume, CC 11 Expression Pedal, CC 64 Sustain, CC 123 All Notes Off. Per p. 82, these are NOT affected by the Param TX/RX setting — they always work. |
| **Engine CCs** (Param TX/RX = CC) | 🟡 documented, not yet wire-verified | The full synthesis engine is CC-addressable per the chart on pp. 94–96. ~120 CCs across Osc / Mixer / Filter / Amp / Env / LFO / Mutator / Macro / Arp / FX. **Requires the device's MIDI Param TX/RX setting set to CC** (System Setup → MIDI page 10). |
| **Engine NRPNs** (Param TX/RX = NRPN) | 🟡 documented but mapping not in manual text | Same chart re-encoded as 14-bit NRPNs for higher resolution. ASM does not publish the NRPN MSB/LSB mapping in the manual we have. May be in the ASM Manager source or community docs. |
| **Program Change + Bank Select** | 🟢 documented | Bank A–H = MSB 0, LSB 0–7. PC 0–127 selects within bank. Pgm Chg TX/RX toggles on MIDI page 11. |
| **SysEx patch dump** | 🔴 unknown | "Send Patch" / "Send All Patches" actions exist (MIDI page 10) — sends current patch / all banks as SysEx. Format is **not published**. ASM Manager parses it; community decodes are possible follow-ups. |
| **MPE** | 🟡 documented | On/off toggle on MIDI page 9. Out of scope for v1. |

## Capability matrix (what tool calls would let Claude do)

| Capability | BK-030 primitive | Status |
|---|---|---|
| Set master volume / mod wheel / sustain | `send_cc` | 🟢 ready to demo (no device-specific schema needed) |
| Switch patch within a bank | `send_program_change` | 🟢 ready (PC 0–127) |
| Switch patch across banks | `send_program_change` with bank MSB/LSB | 🟢 ready |
| Edit any synthesis parameter (cutoff, env attack, …) | `send_cc` once Param TX/RX = CC | 🟡 needs schema sugar to be ergonomic; raw `send_cc` works today |
| Edit at higher resolution | `send_nrpn` once Param TX/RX = NRPN | 🟡 same — needs NRPN map; raw bytes work once we have the mapping |
| Trigger notes (test patches, demo) | `send_note` | 🟢 ready |
| Patch dump / restore | `send_sysex` + parser | 🔴 format unpublished |
| List factory patches by name | local lookup against the xlsx + `send_program_change` | 🟢 ready (xlsx is in-repo) |

**Headline:** the entire synthesis engine and patch-switching is
addressable through stock CC and NRPN today. There is **no
capture-based RE required** to ship a useful tool — this is a sharp
contrast to the AM4, which needed 30+ sessions of wire-RE to get to
the same place.

## Roadmap (cribbed from `04-BACKLOG.md` BK-031)

1. **A — Schema module.** `src/knowledge/hydrasynth/params.ts` —
   every CC and (if available) NRPN with module / parameter name /
   range / unit. Generated from the manual chart.
2. **B — Tool sugar over BK-030.**
   - `set_hydrasynth_param(port, module, name, value)` — looks up
     CC, calls `send_cc` (or `send_nrpn` for high-res).
   - `set_hydrasynth_macro(port, macro, value)` — Macro 1–8.
   - `switch_hydrasynth_patch(port, bank, program)` — bank select +
     PC.
   - `list_hydrasynth_patches()` — reads the factory xlsx.
3. **C — Lineage / pedagogy.** Synthesis-concept tool descriptions
   (e.g., "Filter 1 Cutoff: low values close the filter, removing
   high frequencies; high values open it"). Founder is new to
   synthesis — these descriptions double as docs.
4. **D — Founder hardware-validation pass.** Real device, real
   conversation, several patches.
5. **E (stretch) — SysEx patch format RE.** If community decodes
   exist, pick them up. Otherwise queue.

## Non-goals (v1)

- Multi-Hydrasynth Overflow mode (manual p. 83) — niche.
- Microtonal scale uploads — deferred.
- MPE routing — deferred.
- Hydrasynth Deluxe multi-patch mode — Explorer is single-patch
  only, so this is moot for our specific device.
