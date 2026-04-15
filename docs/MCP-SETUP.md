# Connecting the AM4 Tone Agent to Claude Desktop

This is the one-time setup to wire the local MCP server into Claude
Desktop so you can control the AM4 from chat.

## Prerequisites

1. **AM4 connected by USB** with Fractal's AM4 USB driver installed
   ([downloads](https://www.fractalaudio.com/am4-downloads/)).
2. **Dependencies installed** — from the repo root:

   ```bash
   npm install
   ```

   This builds `node-midi` via node-gyp, which needs Visual Studio
   Build Tools on Windows. If the build fails, install them via:

   ```bash
   npm install --global windows-build-tools
   ```

   then re-run `npm install`.

3. **Verify the hardware path** before touching Claude Desktop:

   ```bash
   npm run write-test
   ```

   This should change Amp Gain on the device. If it fails, the MCP
   server will fail the same way — fix the hardware path first.

## Wire up Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json`. If the file
doesn't exist yet, create it. Add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "am4-tone-agent": {
      "command": "npx",
      "args": ["tsx", "C:\\dev\\am4-tone-agent\\src\\server\\index.ts"],
      "env": {}
    }
  }
}
```

Adjust the path to wherever the repo lives. If you have other MCP
servers already, just add the `am4-tone-agent` key alongside them
inside `mcpServers`.

Restart Claude Desktop. In a new chat, the AM4 tools should appear in
the tool panel. If they don't:

- Check `%APPDATA%\Claude\logs\` for the MCP server log — it logs to
  stderr and Claude Desktop tees that to disk.
- Confirm the JSON is valid (trailing commas will kill the parser).
- Try `npm run server` at a terminal and confirm it prints
  `AM4 Tone Agent MCP server running on stdio.` before exiting (it
  will exit immediately because there's no stdin reader — that's
  expected; it proves the module loads).
- Run `npm run smoke-server` to do a full client-handshake simulation
  without Claude Desktop in the loop.

## Tools exposed (v0.1)

- **`set_param`** — `(block, name, value)` — write any parameter in
  `KNOWN_PARAMS`. Numbers for knobs/dB/ms/%; strings or wire indices
  for enum dropdowns.
- **`list_params`** — describe every parameter Claude can write.
- **`list_enum_values`** — `(block, name)` — for enum params, list the
  valid dropdown names.

## Example prompts to try

> "Set the amp gain to 7 and reduce the bass to 4."

> "What amp types are available?" *(call `list_enum_values` with
> `block="amp"`, `name="type"`)*

> "Switch the drive to a Klon." *(relaxed name matching will pick a
> close Klon-family entry from the 78-entry drive dictionary)*

> "Turn the reverb mix up to 40% and change the reverb type to
> something roomy."

The v0.1 tools are **write-only**. Reading state back from the device
is a Phase 3 tool (the `0x0E` READ_PARAM command — decoded but not yet
exposed). Until then, the AM4's own display is the source of truth.

## Troubleshooting

- **"AM4 not found in MIDI device list"** — the server couldn't open
  the USB port. Check that AM4-Edit is *not* running (it holds the
  port exclusively on Windows). Power-cycle the AM4 if needed.
- **Tool call hangs in Claude Desktop** — the server writes to MIDI
  synchronously, so hangs usually mean `node-midi` couldn't load. Check
  the log file mentioned above.
- **Parameter out of range** — `set_param` validates against the
  param's `displayMin`/`displayMax`. The ranges live in `params.ts`;
  cache-derived ranges are accurate (see `docs/CACHE-DUMP.md`).
