# Hydrasynth Explorer — Sequencing & Arp Plan

Planning doc for arpeggio + sequence support. Status: planning, not
implementation.

---

## Scope decision (2026-04-25)

The founder explicitly narrowed the scope from the original
"discuss-then-save-to-device-for-computer-free-playback" vision to
this:

> *"Just plan on being able to send an arpeggio sequence of notes
> and have them play — so we can test tones by saying something like
> 'play an A-minor arpeggio repeating' or load the 'Stranger Things
> arpeggio' if that is possible and simple enough."*

So the deliverable is a **conversational arpeggio-as-tone-test
tool**, not a performance / save-to-device system. The earlier
research into Latch / Chord Mode / save-to-patch is filed as
"deferred" in § 4 below, in case the goal expands later.

The use case is tight: while iterating on a patch, the user asks
Claude to "play an A-minor arp" so they can hear the patch in
motion. Claude tweaks parameters (filter cutoff, envelope, mod
matrix) while the arp keeps playing. Stop on demand.

---

## 1. Milestone M1.5 — Arpeggio playback

🟢 **Buildable now**, sits between M1 (already shipped) and M2
(tone vocabulary). Effort: ~2–3 hours.

The arp runs **computer-side**, not on the device's onboard arp.
That's deliberate:

- Tighter control (rate, pattern, swing, velocity per step).
- No dependency on the patch's arp on/off state — works on any
  patch out of the box.
- Stoppable via `hydra_stop_arpeggio` without touching the patch.
- Predictable across patches — the founder doesn't have to
  remember which patches have arp enabled.

The Hydrasynth is just receiving Note On / Note Off streams over
USB MIDI, the same way it would from a sequencer plugged into its
MIDI In.

### Tools

**`hydra_play_arpeggio({ chord, pattern?, bpm?, rate?, octaves?, duration_bars?, velocity? })`**

Start an arpeggio. Returns immediately; the loop runs in the
background until duration elapses or `hydra_stop_arpeggio` is called.

- `chord` — accepted forms:
  - Chord name: `"Am"`, `"C"`, `"Cmaj7"`, `"Dm7"`, `"F#dim"`, etc.
  - Note name array: `["A4", "C5", "E5"]`
  - MIDI number array: `[69, 72, 76]`
- `pattern` — defaults to `"up"`. Options: `"up"`, `"down"`,
  `"updown"`, `"as-played"` (use the chord notes in caller order),
  `"random"`. Mirrors the Hydrasynth's onboard arp Mode names so
  the vocabulary feels native.
- `bpm` — defaults to 120.
- `rate` — defaults to `"1/16"`. Options: `"1/4"`, `"1/8"`,
  `"1/16"`, `"1/32"`, `"1/8t"` (eighth triplet), `"1/16t"`.
- `octaves` — 1, 2, or 3. Spans the arp across multiple octaves
  before repeating.
- `duration_bars` — defaults to ∞ (runs until stopped). When set,
  loop ends after N bars and a final Note Off lands.
- `velocity` — defaults to 96.

**`hydra_play_riff({ name, bpm?, loops?, transpose? })`**

Play a named famous arpeggio from a small curated library.

- `name` — e.g. `"stranger-things"`, `"tubular-bells"`,
  `"around-the-world"`. Curated content; ships with maybe 5–10
  starter entries and grows by request.
- `bpm`, `loops`, `transpose` — optional overrides.

**`hydra_stop_arpeggio()`**

Cancel any running arpeggio / riff. Sends Note Off for any
currently-held note plus an All Notes Off (CC 123) safety panic.

### Implementation sketch

```typescript
// Module-scope state, single active sequence.
let activeTimer: NodeJS.Timeout | undefined;
let activeNotes: number[] = [];

function startArpeggio(notes: number[], stepMs: number, vel: number) {
  stopArpeggio();
  let idx = 0;
  let lastNote: number | undefined;
  const tick = () => {
    if (lastNote !== undefined) midi.send(noteOff(lastNote));
    const note = notes[idx % notes.length];
    midi.send(noteOn(note, vel));
    lastNote = note;
    activeNotes = [note];
    idx++;
  };
  tick();                                   // play first note immediately
  activeTimer = setInterval(tick, stepMs);
}

function stopArpeggio() {
  if (activeTimer) clearInterval(activeTimer);
  activeTimer = undefined;
  for (const n of activeNotes) midi.send(noteOff(n));
  midi.send(ccBytes(channel, 123, 0));      // All Notes Off panic
  activeNotes = [];
}
```

### Chord-name parser

Hand-rolled, handles common chord types:

| Suffix | Intervals (semitones from root) |
|---|---|
| (none) / `maj` | 0, 4, 7 |
| `m` / `min` | 0, 3, 7 |
| `7` | 0, 4, 7, 10 |
| `maj7` / `M7` | 0, 4, 7, 11 |
| `m7` | 0, 3, 7, 10 |
| `dim` | 0, 3, 6 |
| `dim7` | 0, 3, 6, 9 |
| `aug` | 0, 4, 8 |
| `sus2` | 0, 2, 7 |
| `sus4` | 0, 5, 7 |
| `add9` | 0, 4, 7, 14 |

Default octave for chord-name input: middle (root = C4 / 60).
Caller can override with `_octave` suffix (`"Am_5"`).

### Riff library (starter content)

Hand-curated JSON. Each riff is `{ notes, bpm, rate, pattern_hint }`.
Initial entries to seed:

- **stranger-things** — *Survive*-era 8-step minor arpeggio in C
  minor, 16th notes at ~110 BPM. Notes (one bar): `C4 G4 Eb5 G4 C5 G4 Eb5 G4`
  or similar — needs verification against the show.
- **tubular-bells** — Mike Oldfield, the famous 15/8 arp. Notes:
  `E5 A4 C5 E5 D5 A4 C5 D5 ...`
- **around-the-world** — Daft Punk bass arp.
- **closer** — Nine Inch Nails synth arp.
- **axel-f** — *Beverly Hills Cop* lead riff (technically a
  melody, not an arp, but iconic).

Every entry has `[FLAG — VERIFY]` until we audition them and
confirm against original recordings. Treat as starter scaffolding
that grows by request — when the founder asks for one we don't
have, we add it.

### Validation / safety

- Cap loop duration at 10 minutes if `duration_bars` not set, to
  prevent runaway processes.
- BPM clamped to 30..300.
- Stop cleanly on server shutdown (intercept SIGTERM / SIGINT in
  the MCP server, send All Notes Off).
- One sequence at a time — starting a new arp cancels the
  previous one.

---

## 2. Where this fits in the milestone order

Updated:

1. **M1 (done)** — bare MCP surface (5 tools).
2. **M1.5 (~2–3 hr)** — arpeggio playback. Three tools above.
3. **M2** — tone vocabulary in tool descriptions. M1.5 makes M2
   work much better — Claude can audition each parameter change
   against a held arp instead of single staccato notes.
4. **M3** — factory-patch starting points.
5. **M4** — high-level tone sugar (envelope shapes, etc.).
6. **M5+** — bidirectional MIDI, performance mode, etc. Deferred
   per the scope decision above.

---

## 3. Use cases this enables

After M1.5 ships, conversations like these work:

- *"Play an A-minor arpeggio repeating."*
  → `hydra_play_arpeggio({ chord: "Am" })`. Plays at default
    120 BPM 1/16 notes, runs until stopped.

- *"Stop."*
  → `hydra_stop_arpeggio()`.

- *"Play the Stranger Things arpeggio at 90 BPM."*
  → `hydra_play_riff({ name: "stranger-things", bpm: 90 })`.

- *"Play a Cmaj7 up-down at 100 BPM, slower 8th notes."*
  → `hydra_play_arpeggio({ chord: "Cmaj7", pattern: "updown",
                          bpm: 100, rate: "1/8" })`.

- *"While that's playing, lower the filter cutoff a lot."*
  → arp keeps running, Claude calls
    `hydra_set_param({ id: "filter1.cutoff", value: 30 })`.

The last one is the workflow the founder explicitly described —
audible iteration on a patch while the arp keeps playing.

---

## 4. Deferred — researched but out of scope

Recorded so the research isn't lost if the goal expands later.

### "Save to device for computer-free playback"

🔴 **Not achievable on this hardware.** The Hydrasynth Explorer's
patch storage holds synth tone + arp settings + macros + mod
matrix, but **no notes**. Confirmed in the manual (p. 21):

> *"The chord is **not saved with a patch**, and will be **erased
> when the Hydrasynth Explorer is power-cycled**."*

That applies to both Chord Mode and Latch — both are RAM-only,
non-persistent. The device fundamentally requires note input from
keys, MIDI in, or external sequencer to play sound. There's no
internal note sequencer block.

If this goal returns, the closest workarounds are:
- **One-touch startup** (free): pre-design tone+arp in a patch
  with Claude. At standalone startup, user plays a chord + presses
  LATCH. Two physical actions, then hands-free until power-off.
- **External sequencer** (~$50–150 hardware add): a small standalone
  sequencer (Korg SQ-1, Arturia BeatStep, etc.) plugged into the
  Hydrasynth's 5-pin MIDI In, auto-playing at boot. Hydrasynth's
  internal arp responds per manual p. 84.
- **Hydrasynth Deluxe upgrade**: the Deluxe model has a per-patch
  step sequencer; the Explorer doesn't.

### Macro keys triggering sequences

🔴 **Knobs, not buttons.** Macros 1–8 are continuous controls
(0–127), not binary triggers. Threshold-based hacks (Macro > 64 =
fire) feel weird. The bottom octave + Local Off is a more
musical-feeling alternative if this comes back.

### Performance Mode (PC → auto-chord)

🟡 **Buildable but deferred.** Listen for incoming Program Change
in the MCP server, auto-fire the matching Claude-designed chord.
Requires bidirectional MIDI (M5) and computer running passively.
Not in scope per the narrowed goal.

### Generative music modes, polyrhythm, MPE orchestration

🟡 **Buildable but deferred.** Cool ideas, not in scope per the
narrowed goal. Originally listed in § 3 of the previous version
of this doc; available in git history if needed.

### SysEx patch format RE

🔴 **Long-tail, low ROI.** Format is unpublished. Even if decoded,
the device has no internal note storage, so writing custom note
data wouldn't render to anything.
