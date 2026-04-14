# Phase 0 — Feasibility Proof Plan

## Goal
Confirm that we can communicate with the Fractal AM4 over USB without
AM4-Edit running. This is the single most critical assumption in the project.
Everything else depends on it.

---

## What We Need to Prove

### Proof 1 — USB MIDI Connection
Node.js can open the AM4 as a MIDI device and send/receive SysEx.

### Proof 2 — Basic SysEx Handshake
We can send a known SysEx command (e.g. GET_FIRMWARE_VERSION) and receive
a valid response. This proves two-way communication.

### Proof 3 — Preset Read
We can request and receive the current preset's binary data off the device.

### Proof 4 — Parameter Write
We can change a single parameter (e.g. Amp gain) via SysEx and hear the
result on the AM4 in real time.

### Proof 5 — Preset Write
We can write a complete preset to a slot and have it load correctly.

---

## Known Facts (from research)

### SysEx Envelope (all Fractal devices)
```
F0          — SysEx start
00 01 74    — Fractal Audio manufacturer ID
15          — AM4 model ID (0x15)
[function]  — command byte
[payload]   — variable length
[checksum]  — XOR of all bytes from F0 to last payload byte, AND'd with 0x7F
F7          — SysEx end
```

### AM4 Model ID
`0x15` — confirmed from Fractal Audio wiki MIDI SysEx page

### Checksum Algorithm (confirmed, same for all Fractal devices)
```typescript
function fractalChecksum(bytes: number[]): number {
  // XOR all bytes from F0 through last payload byte
  const xor = bytes.reduce((acc, b) => acc ^ b, 0);
  // Strip high bit (MIDI SysEx bytes must have MSB = 0)
  return xor & 0x7F;
}
```

### Known Function IDs (from Axe-FX II documentation — likely shared)
These are confirmed for Axe-FX II / AX8 and need verification for AM4:
- `0x08` — GET_FIRMWARE_VERSION (also acts as "hello")
- `0x0F` — GET_PRESET_NAME
- `0x14` — GET_PRESET_NUMBER
- `0x3C` — SET_PRESET_NUMBER
- `0x77` — Preset data header (observed in .syx files)
- `0x78` — Preset data chunk (observed in .syx files)
- `0x79` — Preset data footer (observed in .syx files)

### Known AM4 SysEx Commands (confirmed from forum research)
Mode switching — these work, confirmed by community:
```
F0 00 01 74 15 12 48 4A F7  — Presets mode
F0 00 01 74 15 12 58 5A F7  — Amp mode
F0 00 01 74 15 12 49 4B F7  — Scenes mode
F0 00 01 74 15 12 4A 48 F7  — Effects mode
F0 00 01 74 15 12 18 1A F7  — Tuner/tap tempo
```

These are ideal first test commands — they have visible results on the AM4
display so we can confirm reception without needing to decode a response.

---

## Setup Requirements

### Hardware
- Fractal AM4 connected via USB to Windows ThinkPad
- Fractal AM4 USB driver installed (from fractalaudio.com/am4-downloads/)

### Software
- Node.js 18+
- node-midi npm package
- MIDI-OX (Windows) — for monitoring SysEx traffic
- AM4-Edit — open alongside MIDI-OX to generate sniffable traffic

### Driver Install
URL: https://www.fractalaudio.com/am4-downloads/
Install the Windows USB driver before any MIDI communication attempt.
The AM4 must appear as a MIDI device in Windows Device Manager.

---

## Step-by-Step Proof Script

### Step 1 — Enumerate MIDI Devices
```typescript
import midi from 'midi';

const input = new midi.Input();
const output = new midi.Output();

console.log('--- MIDI Inputs ---');
for (let i = 0; i < input.getPortCount(); i++) {
  console.log(i, input.getPortName(i));
}

console.log('--- MIDI Outputs ---');
for (let i = 0; i < output.getPortCount(); i++) {
  console.log(i, output.getPortName(i));
}
```
Expected: AM4 appears in both lists, e.g. "Fractal Audio AM4" or similar.

### Step 2 — Send Mode Switch Command
```typescript
// Switch AM4 to Scenes mode — visible result on device display
const AM4_SCENES_MODE = [0xF0, 0x00, 0x01, 0x74, 0x15, 0x12, 0x49, 0x4B, 0xF7];
output.sendMessage(AM4_SCENES_MODE);
```
Expected: AM4 display switches to Scenes mode.

### Step 3 — Firmware Version Request (Hello)
```typescript
// F0 00 01 74 15 08 [checksum] F7
// Checksum: XOR(F0,00,01,74,15,08) & 0x7F
const payload = [0xF0, 0x00, 0x01, 0x74, 0x15, 0x08];
const checksum = payload.reduce((a, b) => a ^ b, 0) & 0x7F;
output.sendMessage([...payload, checksum, 0xF7]);
```
Listen for response on input port. Log all incoming bytes.

### Step 4 — MIDI-OX Sniffing Session
With AM4-Edit open and MIDI-OX monitoring:
1. Load a preset in AM4-Edit
2. Change Amp gain knob
3. Save preset
4. Capture the SysEx stream for each action

This gives us the raw bytes for parameter changes and preset writes
that we then reverse-engineer into our encoder.

---

## Success Criteria
- [ ] AM4 appears as MIDI device in Node.js
- [ ] Mode switch command produces visible result on AM4
- [ ] Firmware version response received and logged
- [ ] At least one parameter change captured via MIDI-OX sniff
- [ ] Preset read/write round-trip works without AM4-Edit

---

## Risk Factors
1. **AM4 may require AM4-Edit to "activate" USB MIDI** — some devices need
   the editor to negotiate a session first. Mitigation: open AM4-Edit,
   confirm MIDI-OX sees traffic, then close AM4-Edit and try Node.js.

2. **Function IDs may differ from Axe-FX II** — the AM4 is a newer platform.
   Mitigation: sniff all traffic from AM4-Edit before assuming any function ID.

3. **Preset payload may be encrypted or compressed** — unlikely given community
   history but possible. Mitigation: compare two presets that differ by one
   parameter and look for single-byte differences.
