# Hydrasynth Explorer — first round-trip smoke

The goal of this doc is to design end-to-end (on paper) the cheapest
possible round-trip test that proves the device responds to MIDI we
send from this codebase. Once this passes, we have ground truth
that the rest of BK-031 can stand on.

---

## 1. Pick the parameter

**Target: CC #7 — Master Volume.**

Reasons it's the right first smoke target:

- 🟢 **Always on.** Per manual p. 82, CC 7 is exempt from the
  device's Param TX/RX setting. It works whether the device is in
  CC, NRPN, or even Off mode for engine control. Zero device-side
  prerequisites.
- 🟢 **Audible immediately.** Master Volume affects the device's
  output level — no patch wiring required, no headphones-vs-line
  question, no need to even hold a note. The volume of any sound
  the device is producing changes.
- 🟢 **Standard MIDI.** CC 7 is the universal "channel volume"
  control across the entire MIDI spec. Behavior is unambiguous.
- 🟢 **Reversible.** Sending `B0 07 7F` (127) restores full volume.
  Cannot damage a patch, cannot persist beyond power cycle.
- 🟢 **One byte of variance.** Three-byte message, one of which is
  the value. Trivial to validate visually if we hex-print it.

Alternatives considered and rejected for first-smoke:

- **CC 1 (Mod Wheel).** Also exempt, also safe — but its effect is
  patch-dependent (it modulates whatever the patch's mod matrix has
  wired to ModWhl). Master Volume is more deterministic.
- **CC 64 (Sustain).** Requires holding notes to observe.
- **Filter 1 Cutoff (CC 74-ish, pending clean chart).** Requires
  Param TX/RX = CC and a held note. Two extra preconditions.
- **Program Change.** Requires Pgm Chg RX = On (default, but still
  one extra precondition) and changes the active patch — slightly
  destructive feel, even though it's trivially reversible.
- **Note On / Off.** Loud, requires audio routing thought.

---

## 2. The wire bytes

MIDI Control Change message on channel 1:

```
Status:  0xB0   (Control Change, channel 1)
CC:      0x07   (Master Volume)
Value:   0xVV   (0x00 = silent, 0x7F = full)
```

Three raw bytes total. No SysEx envelope, no checksum, no length
prefix. Standard short MIDI message.

The full smoke sequence:

| Step | Bytes | What it does |
|---|---|---|
| 1 | `B0 07 00` | Volume to 0 — device should go silent. |
| 2 | (~500 ms wait) | Founder confirms silence. |
| 3 | `B0 07 7F` | Volume to max — device returns. |
| 4 | (~500 ms wait) | Founder confirms full volume. |
| 5 | `B0 07 64` | Volume to 100 (~80%) — comfortable level. |

---

## 3. Confirmation strategy

**The Hydrasynth does not ack CCs.** Unlike the AM4 (which echoes
WRITE-class SysEx within ~300 ms — see `docs/SYSEX-MAP.md` §6 and
`isWriteEcho` in `src/protocol/setParam.ts`), consumer MIDI synths
generally accept CCs silently. There is no protocol-level "did it
land" signal.

So confirmation has to come from one of:

- **Audible** — founder hears the volume change. Primary signal.
- **Visual on device** — Master Volume on the Hydrasynth Explorer
  is also exposed as a knob on its top panel, but **incoming MIDI
  CC 7 does not move the physical knob** (knobs are output-only on
  most digital synths). So no visual confirmation here.
- **Loopback** — if we set up a separate MIDI monitor on the
  Hydrasynth's MIDI Out (or USB MIDI in the other direction), we
  can confirm bytes ingressed the device. But that's a feasibility-
  verification harness, not the main confirmation path.

For first smoke: **founder ears.** That's the unambiguous proof.

---

## 4. The script (this branch, no BK-030 dependency)

We don't need to wait for BK-030 to land on main to run this.
A small standalone script under `scripts/hydrasynth/smoke.ts`
can use `node-midi` directly:

```typescript
// scripts/hydrasynth/smoke.ts (planned, not yet written)
import midi from 'midi';

const out = new midi.Output();
const portCount = out.getPortCount();

// Find the Hydrasynth port by name substring
let hydraPort = -1;
for (let i = 0; i < portCount; i++) {
  const name = out.getPortName(i).toLowerCase();
  if (name.includes('hydrasynth')) { hydraPort = i; break; }
}
if (hydraPort < 0) throw new Error('Hydrasynth not found');

out.openPort(hydraPort);

const send = (bytes: number[]) => {
  console.log('->', bytes.map(b => b.toString(16).padStart(2,'0')).join(' '));
  out.sendMessage(bytes);
};

send([0xB0, 0x07, 0x00]);              // silent
await new Promise(r => setTimeout(r, 1000));
send([0xB0, 0x07, 0x7F]);              // full
await new Promise(r => setTimeout(r, 1000));
send([0xB0, 0x07, 0x64]);              // ~80%

out.closePort();
```

Run with `npx tsx scripts/hydrasynth/smoke.ts`. No build, no MCP,
no Claude in the loop. Founder plays a note while it runs.

This script is **deliberately disposable** — it exists to validate
the round trip, not to be part of the long-term tool surface. The
real surface will land via BK-030 + BK-031 schema sugar.

---

## 5. The eventual tool path (post-BK-030, on main)

Once BK-030 ships generic-MIDI primitives in the `mcp-midi-tools`
package, the same operation is reachable from Claude Desktop as:

```
Claude calls: send_cc({
  port: "Hydrasynth Explorer",
  channel: 1,
  cc: 7,
  value: 100,
})
```

And then the BK-031 device-specific schema layer sweetens it:

```
Claude calls: set_hydrasynth_param({
  port: "Hydrasynth Explorer",
  module: "System",
  name: "Master Volume",
  value: 100,
})
// internally: looks up CC=7, calls send_cc.
```

The smoke script proves the bottom-of-stack works. BK-030 and
BK-031 layer ergonomics on top.

---

## 6. Architectural takeaway: how much of AM4 generalizes?

This is the question this session was meant to answer for the
device-abstraction seam. The honest answer:

**The transport layer generalizes. The protocol layer does not.**

What generalizes (lives in `src/transport/` or BK-030's
`src/protocol/generic/`):

- Port enumeration (`list_midi_ports` is already device-agnostic —
  see `src/protocol/midi.ts` `listMidiPorts()`).
- Open / close handle management.
- Raw `send(bytes)` / `onMessage(handler)`.
- Stale-handle self-healing (the `ensureMidi()` retry-on-ack-less
  pattern from Session 19i works for any device, though it relies
  on knowing what an "ack" looks like — see below).

What does **not** generalize and stays per-device:

- **Message envelopes.** AM4 wraps everything in
  `F0 00 01 74 15 [function] [payload] [checksum] F7`. Hydrasynth
  uses raw 3-byte CCs / 6-byte NRPNs / opaque SysEx. There is no
  shared envelope.
- **Confirmation model.** AM4 echoes WRITE-class messages within
  ~300 ms; absence-of-echo means silent-absorb. Hydrasynth has no
  ack. The `sendAndAwaitAck` helper in `src/protocol/midi.ts` is
  AM4-shaped — for Hydrasynth, the right primitive is
  fire-and-forget `send_cc` (already what BK-030 specifies).
- **Parameter addressing.** AM4: `pidLow / pidHigh` + cache lookup.
  Hydrasynth: CC number or NRPN MSB/LSB. Different model entirely.
- **Schemas.** Block / channel / scene structure on AM4 has no
  equivalent on Hydrasynth (which has patches → modules →
  parameters with a different topology).

What this means for code organization (when this branch eventually
needs a real seam, not just a smoke):

```
src/
  protocol/                      ← legacy AM4-specific, candidate to
                                   become src/devices/am4/protocol/
                                   when BK-012 (protocol package
                                   split) lands
  transport/                     ← already generic-shaped (node-midi
                                   wrapper + port enumeration); will
                                   be BK-030's home
  devices/
    hydrasynth-explorer/
      params.ts                  ← BK-031 step A (CC + NRPN map)
      tools.ts                   ← BK-031 step B (schema sugar)
      lineage.ts                 ← BK-031 step C (synthesis pedagogy)
```

This branch shouldn't refactor the AM4 layer — that's BK-012's job.
It should add a `src/devices/hydrasynth-explorer/` peer when ready
to write code beyond the smoke script.

**Conclusion:** the AM4 architecture generalizes its transport but
not its protocol. The seam is at the boundary between transport
(generic, MIDI-port-level) and protocol (device-specific). BK-030
formalizes this seam. This branch can prototype Hydrasynth by
either calling `node-midi` directly (smoke) or eventually layering
on top of BK-030 primitives (real tools), but should not reach
into `src/protocol/` (AM4-specific).

---

## 7. What we want from running this

A founder report of:

1. ✅ Did the script find a port whose name contains "hydrasynth"?
   (If not: capture exact OS-reported port name so we adjust the
   substring match.)
2. ✅ Did volume go silent on `B0 07 00`?
3. ✅ Did volume return on `B0 07 7F`?
4. ✅ Did the device show any unexpected behavior (preset change,
   error message, hung state)? Should be no.

If 1–3 are all yes: the round-trip works, BK-031 is unblocked from
the protocol-feasibility side, and the next session can either
(a) start chart-extraction work to populate `params.ts`, or
(b) wait for BK-030 to land before writing tool surface.

If any of 1–3 fails: documented findings go into a new
`SESSIONS.md` in this folder, treated the same way AM4 sessions
are treated — capture, decode, retry.
