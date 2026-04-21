# AM4 Tone Agent

Talk to Claude. Get Fractal AM4 tones.

AM4 Tone Agent is a local [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) server that lets Claude control a Fractal Audio **AM4** guitar amp
modeler over USB/MIDI. Ask Claude for a tone in plain English and the AM4
updates in real time — block layout, amp type, drive, delay, reverb,
scenes, and preset naming.

> **Unaffiliated community tool.** "Fractal Audio", "AM4", and related
> product names are trademarks of Fractal Audio Systems, Inc. This project
> neither claims endorsement from, nor affiliation with, Fractal Audio
> Systems. It communicates with AM4 hardware the user already owns via
> SysEx messages. See [`NOTICE`](./NOTICE) for the full trademark
> statement.

---

## Status

Early preview (v0.1). The protocol layer is hardware-verified, 16 MCP
tools are live, and every tool ships with byte-exact goldens against
real captures. Distribution is still a clone-and-run flow — the signed
Windows `.exe` and one-click installer tracked in the backlog (P5-002,
P5-005, P5-008) haven't shipped yet.

---

## What you can ask Claude to do today

Once connected, Claude can:

- **Build a full preset in one sentence.** *"Build me a clean preset with
  a compressor, a Deluxe Verb Normal amp at gain 4 and bass 6, a 350 ms
  analog delay, and a Deluxe spring reverb at 35% mix."*
- **Tweak individual params.** *"Drop the gain to 3 and bump the reverb
  mix to 50%."*
- **Place, clear, or change effect blocks.** *"Put a Klon-style drive in
  slot 1 and swap the reverb for a plate."*
- **Name and save presets.** *"Save this to Z04 and call it 'Clean
  Machine'."*
- **Manage scenes.** *"Name scene 2 'verse', scene 3 'chorus', scene 4
  'solo'."* / *"Switch to scene 3."*
- **Research tones by real gear.** *"What's the closest drive to a
  Klon?"* / *"Which amp on the AM4 is inspired by a Matchless DC-30?"*
- **Switch presets.** *"Load A01."*

Under the hood Claude picks one of 17 tools (`apply_preset`,
`set_param`, `save_preset`, `switch_scene`, `lookup_lineage`, …) and
sends SysEx to the device. Tool round-trips land in roughly 30–60 ms;
whole-preset builds take under a second.

---

## Requirements

- **Windows 10/11.** macOS / Linux builds are a future item (P5-006).
- **Fractal AM4** connected by USB with Fractal's AM4 USB driver
  installed ([downloads](https://www.fractalaudio.com/am4-downloads/)).
- **Node.js 18+**.
- **Visual Studio Build Tools** (needed to compile the `node-midi`
  native module on first `npm install`). If the build fails, install
  them with `npm install --global windows-build-tools` and re-run
  `npm install`.
- A Claude client that supports MCP — [Claude Desktop](https://claude.ai/download),
  [Claude Code](https://docs.claude.com/en/docs/claude-code), or any
  other MCP-capable host.

**Important:** close AM4-Edit before starting the server. AM4-Edit holds
the USB port exclusively on Windows; the server can't share it.

---

## Install

Clone the repo, install dependencies, and run the hardware smoke test
once before wiring anything into Claude:

```bash
git clone https://github.com/TheAndrewStaker/am4-tone-agent.git
cd am4-tone-agent
npm install
npm run preflight    # typecheck + protocol goldens + MCP smoke test
npm run write-test   # changes amp gain on the device — confirms MIDI path
```

If `write-test` flips the amp gain on the AM4's display, the hardware
path is good and you can wire up your Claude client.

---

## Connect to Claude

### Option 1 — Claude Desktop (GUI config)

Edit `%APPDATA%\Claude\claude_desktop_config.json` (create it if it
doesn't exist) and add:

```json
{
  "mcpServers": {
    "am4-tone-agent": {
      "command": "npx",
      "args": ["tsx", "C:\\path\\to\\am4-tone-agent\\src\\server\\index.ts"],
      "env": {}
    }
  }
}
```

Adjust the path. Fully quit Claude Desktop (system tray → Quit, not
just the window's ✕) and relaunch. The tools appear under the **`+`
button → Connectors** in a new chat.

**Microsoft Store build:** Claude Desktop from the Store is sandboxed,
so the config file lives under
`C:\Users\<you>\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json`
instead. The direct-download installer from claude.ai uses the plain
`%APPDATA%\Claude\` path.

Full walkthrough with screenshots-worth of detail:
[`docs/MCP-SETUP.md`](./docs/MCP-SETUP.md).

### Option 2 — Claude Code (CLI)

From your project directory:

```bash
claude mcp add am4-tone-agent -- npx tsx C:\path\to\am4-tone-agent\src\server\index.ts
```

Then start `claude` and the tools are available in your session.

### Option 3 — Any MCP client (raw stdio)

Launch with:

```bash
npm run server
```

The server speaks MCP over stdio. Point your client at the command
`npx tsx C:\path\to\am4-tone-agent\src\server\index.ts`.

---

## Confirm it works

1. Open a new chat in your Claude client. Make sure the AM4 is powered
   on and connected by USB.
2. Ask: **"Using am4-tone-agent, list the MIDI ports you can see."**
   Claude calls `list_midi_ports` and reports a verdict like *"AM4
   detected (in: AM4, out: AM4)"*. If it says the AM4 isn't visible,
   close AM4-Edit and replug the USB cable.
3. Ask: **"Place a compressor in slot 1 and set the level to 6."**
   Watch the AM4 display — slot 1 should flip to Compressor and the
   level knob should jump to 6. Round-trip is under a second.

If step 3 works, you're done. Move on to building full presets.

---

## The 17 tools at a glance

| Tool | What it does |
|---|---|
| `apply_preset` | Build a whole preset in one call — blocks, per-channel params, optional name. Working buffer only; does not save. |
| `set_param` | Write one parameter (amp gain, reverb mix, …). |
| `set_params` | Batch write. Validates the whole batch before any MIDI leaves. |
| `set_block_type` | Place a block (amp, drive, reverb, …) in a signal-chain slot. |
| `set_block_bypass` | Silence / activate a block on the currently-active scene. |
| `save_to_location` | Persist the working buffer to a preset location (gated to Z04 until factory-safety ships). |
| `set_preset_name` | Rename the working-buffer preset. |
| `save_preset` | One-shot rename + save. |
| `set_scene_name` | Rename a scene in the working buffer. |
| `switch_preset` | Load a preset (A01–Z04). |
| `switch_scene` | Switch to scene 1–4. |
| `list_params` | Describe every param Claude can write. |
| `list_block_types` | List the block types that fit each slot. |
| `list_enum_values` | List enum choices for a given param (e.g. all amp types). |
| `list_midi_ports` | Diagnose the USB/MIDI connection. |
| `reconnect_midi` | Force-reopen the AM4 handle after an AM4-Edit excursion. |
| `lookup_lineage` | "What real amp inspired this?" / "Find me a Klon-style drive." |

Full tool descriptions surface inside Claude automatically — just ask.

---

## Safety defaults

- **Z04 is the scratch location.** `save_to_location` and `save_preset`
  refuse to write to any other preset location until factory-preset
  safety classification (P1-008) ships. This keeps your A01–Z03
  factory banks untouched during development.
- **Every write is acknowledged.** `set_param` and friends wait for
  the device's write echo (up to 300 ms) before returning success, so
  "the tool succeeded" means "the AM4 actually took the write."
- **Read-only probes stay read-only.** `scripts/probe.ts` never issues
  any store/save SysEx — it's the designated safe introspection tool.

See [`CLAUDE.md`](./CLAUDE.md) for the full write-safety rules.

---

## Project layout

```
src/
├── protocol/        # verified wire layer (checksum, pack, params, MIDI)
├── ir/              # preset IR + transpiler (IR → SysEx sequence)
├── knowledge/       # lineage JSONs (amp/drive/reverb/… inspired-by data)
└── server/          # MCP server (stdio)
docs/                # protocol reference, session log, planning docs
samples/captured/    # reverse-engineering captures + decoded cache data
scripts/             # probes, verifiers, smoke test
```

- [`docs/STATE.md`](./docs/STATE.md) — current phase and next action.
- [`docs/SYSEX-MAP.md`](./docs/SYSEX-MAP.md) — working protocol reference.
- [`docs/SESSIONS.md`](./docs/SESSIONS.md) — reverse-engineering log,
  chronological.
- [`docs/04-BACKLOG.md`](./docs/04-BACKLOG.md) — phased work items.

---

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Short version: run
`npm run preflight` locally before opening a PR, and add a byte-exact
golden against a real capture if you touch the wire protocol.

Security issues: see [`SECURITY.md`](./SECURITY.md).

---

## License

Apache License 2.0 — see [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).
