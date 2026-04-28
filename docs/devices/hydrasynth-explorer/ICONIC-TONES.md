# Iconic synth tones — Hydrasynth test portfolio

Curated list of recognizable synth sounds the tool aims to recreate
conversationally. Each one doubles as **(a)** a hardware test that
exercises a specific Hydrasynth capability and **(b)** a marketable
demo in the form *"Send a [iconic song] tone to the Hydrasynth"* →
patch lands.

When you do hardware tests, paste the **prompt** column verbatim
into Claude Desktop (with the connector attached + Param TX/RX = NRPN
+ device powered on). Capture which ones land cleanly vs need
iteration; the green-checked ones become the project's "tones the
tool can produce" list.

For **every** fresh-patch build, the prompt should include something
like *"…in one batch with freshPatch true"* so the server prepends
the neutralize prelude. Without it, leftover state from whatever
patch was loaded previously can break the recipe mid-build (see the
2026-04-28 Van Halen Jump session).

## Tier 1 — high recognition, high feasibility (start here)

| # | Song / artist | Original synth | What it exercises | Test prompt |
|---|---|---|---|---|
| 1 | **Van Halen "Jump"** | Oberheim OB-Xa | Polyphonic saw stack, brassy filter envelope, chorus width | *"Send the Van Halen 'Jump' lead synth tone to the hydrasynth as a fresh patch — it's the iconic OB-Xa polyphonic synth"* |
| 2 | **A-ha "Take On Me"** | Yamaha DX7 marimba | FM-style bell-pluck — first real test of the **mutators** (FM Linear mode) | *"Send the A-ha 'Take On Me' lead synth as a fresh patch — DX7-style FM marimba/bell pluck"* |
| 3 | **Stranger Things theme** | Roland Juno-60 + sequencer | Sub-bass arpeggio with filter sweep — synthwave aesthetic | *"Send the Stranger Things theme bass arpeggio as a fresh patch — Juno-60 with filter sweep"* |
| 4 | **Vangelis "Chariots of Fire"** | Yamaha CS-80 brass | Slow swell brass pad with ring-mod shimmer | *"Send the Vangelis 'Chariots of Fire' main synth pad as a fresh patch — CS-80 brass with that signature swell"* |
| 5 | **Tom Petty "Breakdown"** | Vox Continental / Synclavier organ | Soft organ-style pad, reference test from session 1 | *"Build the Tom Petty 'Breakdown' organ tone on the hydrasynth as a fresh patch: oscillator 1 sine wave with semi 0, oscillator 2 sine wave with semi +12, mixer osc1 vol 100 osc2 vol 55, filter 1 type LP Ladder 12 with cutoff 60 and resonance 15, env1 attack 0 decay 127 sustain 127 release 65, prefxtype Lo-Fi, postfxtype Rotary"* |
| 6 | **Steve Winwood "While You See a Chance"** | Minimoog + Prophet-5 | Mono lead with detuned saws, glide, vibrato, chorus | *"Send a 'While You See a Chance' lead synth tone to the hydrasynth as a fresh patch — Minimoog-style with detuned saws, glide, and Prophet-5 chorus"* |

## Tier 2 — recognizable but trickier

| # | Song / artist | Original synth | Why it's harder | Test prompt |
|---|---|---|---|---|
| 7 | **Daft Punk "Around the World" bass** | Roland TB-303 | Acid bass needs squelchy ladder filter + per-note retriggers | *"Send the Daft Punk 'Around the World' bassline tone as a fresh patch — TB-303 acid bass"* |
| 8 | **Pink Floyd "Shine On You Crazy Diamond"** | Minimoog | Pure singing lead with glide. Hydrasynth nails this; biggest challenge is performance vibrato/bend phrasing not patch | *"Send the 'Shine On You Crazy Diamond' lead synth as a fresh patch — Minimoog singing lead"* |
| 9 | **Phil Collins "In the Air Tonight" pad** | Sequential Prophet-5 | Slow ensemble pad with chorus | *"Send the 'In the Air Tonight' synth pad as a fresh patch — Prophet-5 ensemble pad"* |
| 10 | **Kraftwerk "The Robots" lead** | Minimoog | Minimalist square wave with portamento — tests the simplest patches honestly | *"Send the Kraftwerk 'The Robots' lead synth as a fresh patch — minimalist Minimoog square wave"* |
| 11 | **Berlin "Take My Breath Away"** | Yamaha CS-80 | String-bass pad foundation | *"Send the 'Take My Breath Away' synth pad as a fresh patch — CS-80 string bass"* |

## Tier 3 — interesting but expect partial fidelity

| # | Song / artist | Original synth | Why partial |
|---|---|---|---|
| 12 | **Yes "Owner of a Lonely Heart" stab** | Fairlight CMI samples | Sample-based, can't fully recreate; Hydrasynth wavescan can approximate |
| 13 | **Earth Wind & Fire "September" brass** | Yamaha DX7 brass | FM brass — mutator can approximate but not nail |
| 14 | **Charli XCX / hyperpop modern lead** | Serum, Vital | Wavetable with formant character — wavescan is closest analog |
| 15 | **Boards of Canada hazy pad** | Roland Juno-106 | Heavy modulation + tape-emulation character; chorus alone can't replicate |

## Recommended test order for the next 2–3 sessions

1. **Van Halen "Jump"** — highest recognition, exercises poly + saw stack + filter envelope. Gold standard 80s lead.
2. **A-ha "Take On Me"** — first real test of the **mutators** (FM mode), which we haven't touched yet. Big breadth gain.
3. **Stranger Things** — sequenced bass arp + LFO. Tests live-sequencing flow against a recognizable cultural reference.

After those three: Vangelis (ring mod), TB-303 (resonant bass), CS-80 brass. Each one extends the demo portfolio + stress-tests a different Hydrasynth capability.

## Test results log

Append rows here as tests complete. Mark patches that landed
cleanly with ✅; those needing iteration with 🟡; those that didn't
land at all with ❌.

| Date | # | Tone | Result | Notes |
|---|---|---|---|---|
| 2026-04-26 | 5 | Tom Petty "Breakdown" | ✅ | Session 1; required the fixes that became BK-035 (alias, auto-scale) before landing |
| 2026-04-28 | 6 | Steve Winwood "While You See a Chance" | ✅ | Session 2; minor glitchy artifact from chorus depth, resolved with chorus pull-back |
| 2026-04-28 | 1 | Van Halen "Jump" | 🟡 | Session 3; landed after INIT button + resend. Surfaced bleed-through bug — fixed in 0e2d9cc with `freshPatch: true` flag. Re-test recommended. |
