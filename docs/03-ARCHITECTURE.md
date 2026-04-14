# Architecture — AM4 Tone Agent

## System Overview

```
┌─────────────────────────────────────────────────────┐
│  Claude Desktop (claude.ai)                         │
│  User types: "Amber by 311, 4 scenes"               │
└──────────────────────┬──────────────────────────────┘
                       │ MCP protocol (stdio)
┌──────────────────────▼──────────────────────────────┐
│  MCP Server  (Node.js / TypeScript)                 │
│  — Tool definitions                                 │
│  — Tone research context                            │
│  — Preset safety logic                              │
│  — Slot management                                  │
└──────────────────────┬──────────────────────────────┘
                       │ TypeScript function calls
┌──────────────────────▼──────────────────────────────┐
│  AM4 Protocol Layer  (TypeScript)                   │
│  — SysEx encoder/decoder                           │
│  — Checksum calculation                            │
│  — Block parameter maps                            │
│  — Preset/scene binary format                      │
└──────────────────────┬──────────────────────────────┘
                       │ node-midi
┌──────────────────────▼──────────────────────────────┐
│  USB/MIDI Transport                                 │
│  — Fractal AM4 USB driver (Windows)                │
│  — node-midi input/output ports                    │
└──────────────────────┬──────────────────────────────┘
                       │ USB cable
┌──────────────────────▼──────────────────────────────┐
│  Fractal AM4 Hardware                               │
└─────────────────────────────────────────────────────┘
```

---

## Layer Responsibilities

### 1. MCP Server (`src/server/`)
The Claude-facing interface. Exposes tools that Claude calls.
Does NOT contain any MIDI logic — purely orchestration and safety.

**MCP Tools (planned):**
```typescript
// Tone building
apply_preset(slot: string, preset: AM4Preset): ConfirmationResult
build_preset_from_description(description: string): AM4Preset
refine_preset(slot: string, feedback: string): AM4Preset

// Slot management
read_slot(slot: string): AM4Preset | FactoryPreset | Empty
backup_slot(slot: string): BackupRecord
restore_slot(slot: string, backup: BackupRecord): void
list_slots(range?: string): SlotSummary[]

// Device
get_firmware_version(): string
get_current_preset(): AM4Preset
set_current_preset(slot: string): void
```

**Safety Rules (enforced in MCP layer):**
- Never write without reading first
- Always backup before overwrite if slot is non-empty and non-factory
- Always present confirmation summary before any destructive operation
- Factory preset detection: compare slot against known factory checksums

### 2. AM4 Protocol Layer (`src/protocol/`)
Pure TypeScript. No Claude, no MCP. Testable in isolation.

**Modules:**
```
src/protocol/
  sysex.ts        — envelope, checksum, framing
  encoder.ts      — IR → binary SysEx
  decoder.ts      — binary SysEx → IR
  blocks/
    amp.ts        — Amp block parameters
    cab.ts        — Cab/DynaCab parameters
    drive.ts      — Drive block parameters
    delay.ts      — Delay block parameters
    reverb.ts     — Reverb block parameters
    filter.ts     — Filter/Wah parameters
    compressor.ts — Compressor parameters
    volume.ts     — Volume/Pan parameters
    gate.ts       — Gate/Expander parameters
  presets.ts      — Preset structure, scenes, channels
  factory.ts      — Factory preset checksums + metadata
```

### 3. Intermediate Representation (`src/ir/`)
Device-agnostic preset format. Claude builds this; encoder converts it to SysEx.

```typescript
interface AM4Preset {
  name: string;           // max 32 chars
  tempo: number;          // BPM
  inputGate: InputGate;
  // slot1..slot4 are the four effect slots; any slot may hold any block type; Drive may appear in up to two slots.
  blocks: {
    slot1: Block | null;  // AM4 has 4 effect slots
    slot2: Block | null;
    slot3: Block | null;
    slot4: Block | null;
  };
  scenes: [Scene, Scene, Scene, Scene];  // exactly 4 scenes (index 0–3 in SysEx, displayed 1–4 on hardware)
}

interface Scene {
  name: string;
  blocks: {
    slot1: { enabled: boolean; channel: 'A' | 'B' | 'C' | 'D' };
    slot2: { enabled: boolean; channel: 'A' | 'B' | 'C' | 'D' };
    slot3: { enabled: boolean; channel: 'A' | 'B' | 'C' | 'D' };
    slot4: { enabled: boolean; channel: 'A' | 'B' | 'C' | 'D' };
  };
}
```

### 4. Transport Layer (`src/transport/`)
Thin wrapper around node-midi. Handles port discovery, connection
lifecycle, and raw SysEx send/receive.

```typescript
interface AM4Transport {
  connect(): Promise<void>;
  disconnect(): void;
  send(sysex: number[]): Promise<void>;
  request(sysex: number[], timeoutMs?: number): Promise<number[]>;
  onMessage(handler: (data: number[]) => void): void;
}
```

---

## Slot Naming Convention
The AM4 uses Fractal's native bank/letter system. The app uses this natively.

```
Format: [Bank Letter][Two-digit number]
Banks:  A through Z (26 banks)
Slots:  01 through 04 per bank (4 slots each)
Total:  104 preset slots

Examples:
  A01 — Bank A, slot 1 (first factory preset)
  Z04 — Bank Z, slot 4 (last slot, #104)
  M02 — Bank M, slot 2

Flat index mapping (for internal use):
  index = (bankIndex * 4) + (slotNumber - 1)
  A01 = 0, A02 = 1, A03 = 2, A04 = 3, B01 = 4 ...
```

---

## Preset Safety System

```
┌─────────────────────────────────────────────────────┐
│  BEFORE ANY WRITE OPERATION                         │
│                                                     │
│  1. Read current slot contents                      │
│  2. Check against factory preset checksum table     │
│     → Factory: show "slot contains factory preset"  │
│     → Unknown/custom: show "slot contains           │
│       user preset — backup recommended"             │
│     → Empty: show "slot is empty — safe to write"   │
│                                                     │
│  3. Present compact confirmation summary:           │
│     Writing: AMBER 311                              │
│     Slot:    M01                                    │
│     Current: [Empty / Factory A01 / User preset]   │
│     Backup:  [N/A / Not needed / Saved as M01_bak] │
│     Confirm? [Yes / No]                             │
│                                                     │
│  4. On confirm: backup if needed, then write        │
└─────────────────────────────────────────────────────┘
```

---

## Repo Structure
```
am4-tone-agent/
  src/
    server/         — MCP server, tool definitions
    protocol/       — SysEx encoder/decoder, block maps
    ir/             — Intermediate representation types
    transport/      — node-midi wrapper
    safety/         — Slot read, backup, confirmation logic
    knowledge/      — AM4 block reference data (from manuals)
  scripts/
    probe.ts        — Feasibility proof scripts
    sniff.ts        — MIDI-OX equivalent for logging traffic
    diff-syx.ts     — Compare two .syx files byte by byte
    annotate.ts     — Annotate .syx hex dump with known field names
  samples/
    factory/        — Factory .syx preset files (downloaded from Fractal)
    captured/       — MIDI-OX captured traffic sessions
    decoded/        — Human-readable decoded preset JSON
  docs/
    SYSEX-MAP.md    — Growing reverse-engineered SysEx reference
    BLOCK-PARAMS.md — AM4 block parameter tables (from manual)
    SESSIONS.md     — Sniffing session notes and findings
  tests/
    protocol/       — Unit tests for encoder/decoder round-trips
    integration/    — Tests that require AM4 hardware
  claude.md         — Context file for Claude Code
  package.json
  tsconfig.json
```

---

## Development Phases

### Phase 0 — Feasibility Scripts
`scripts/probe.ts` — proves USB MIDI communication works
`scripts/sniff.ts` — captures AM4-Edit traffic for analysis
No MCP yet. Pure Node.js CLI.

### Phase 1 — Protocol Layer
Build encoder/decoder from sniffed data.
`scripts/diff-syx.ts` and `scripts/annotate.ts` support this.
Full unit test coverage of round-trips before moving on.

### Phase 2 — MCP Server MVP
Wire protocol layer to MCP tools.
Test with Claude Desktop using `claude_desktop_config.json`.
Goal: "set amp to Plexi, gain 6" works end to end.

### Phase 3 — Intelligence Layer
Add block reference knowledge to Claude project.
Famous tone research capability.
Iterative refinement loop.

### Phase 4 — Library Management
Backup/restore system.
Setlist concept.
Slot safety enforcement.
