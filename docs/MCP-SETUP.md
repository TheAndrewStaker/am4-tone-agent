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
doesn't exist yet, create it.

**If you installed Claude Desktop from the Microsoft Store** (UWP
package), the above path is sandboxed — the real file lives at:

```
C:\Users\<you>\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

Use that path instead. The direct-download installer from claude.ai
uses the plain `%APPDATA%\Claude\` path.

Add an entry under `mcpServers`:

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

Fully quit Claude Desktop (system tray → Quit, not just the window's X
— especially on the Store build) and relaunch.

**Where the tools show up:** in a new chat, click the **`+` button at
the bottom of the chat input → "Connectors"**. `am4-tone-agent` should
be listed with its 3 tools. `Settings → Developer` also shows per-server
connection status and log tails. (Older docs mention a "hammer icon" —
that's the old UI; it's now under the `+` menu.)

**How to invoke:** just ask in plain English. Claude decides to call the
tool on its own. On the first message of a session it helps to name the
server explicitly — e.g. *"Using am4-tone-agent, set the amp gain to 7"*
— after that you can drop the preamble.

If Connectors is empty or the tools don't fire:

- Check `%APPDATA%\Claude\logs\` for the MCP server log — it logs to
  stderr and Claude Desktop tees that to disk.
- Confirm the JSON is valid (trailing commas will kill the parser).
- Try `npm run server` at a terminal and confirm it prints
  `AM4 Tone Agent MCP server running on stdio.` before exiting (it
  will exit immediately because there's no stdin reader — that's
  expected; it proves the module loads).
- Run `npm run smoke-server` to do a full client-handshake simulation
  without Claude Desktop in the loop.

## Tools exposed (v0.2)

- **`set_param`** — `(block, name, value)` — write any parameter in
  `KNOWN_PARAMS`. Numbers for knobs/dB/ms/%; strings or wire indices
  for enum dropdowns. Waits for the device's write echo (up to 300 ms)
  and returns a clear "block not placed" error if no echo arrives —
  the AM4 silently absorbs writes to absent blocks.
- **`set_params`** — `(writes[])` — batch version of `set_param`.
  Validates the whole batch before sending any MIDI, then sends each
  write in order with per-write echo confirmation. Stops at the first
  silent-absorb and reports which write failed.
- **`list_params`** — describe every parameter Claude can write.
- **`list_enum_values`** — `(block, name)` — for enum params, list the
  valid dropdown names.

`read_param` was removed in this version: the AM4's READ response
carries param metadata (range, type) rather than the current value
in any obvious byte position. The write-echo path on `set_param`
covers the only practical use case (verifying a write took effect).
A future read implementation requires decoding the 40-byte response
payload, which is deferred.

## Example prompts to try

> "Set the amp gain to 7 and reduce the bass to 4."

> "What amp types are available?" *(call `list_enum_values` with
> `block="amp"`, `name="type"`)*

> "Switch the drive to a Klon." *(relaxed name matching will pick a
> close Klon-family entry from the 78-entry drive dictionary)*

> "Turn the reverb mix up to 40% and change the reverb type to
> something roomy."

The v0.2 tools are **write-with-echo-verify**. Each `set_param` confirms
the device acknowledged the write before returning success. Reading the
live device value (without writing first) is deferred — the AM4's own
display is the secondary source of truth if you need to sanity-check.

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
