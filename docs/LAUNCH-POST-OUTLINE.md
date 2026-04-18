# Launch Post Outline — Fractal Forum Announcement

> Working draft of the forum post that announces AM4 Tone Agent on the
> Fractal Audio forum. Evolves alongside Phase 5 packaging work. **Do
> not publish until the end-to-end install flow works on a clean VM**
> (P5-002 acceptance gate) — a broken announcement damages credibility
> more than a late one, especially with a competing project ("Legend",
> see memory) already making empty claims on the same forum.

---

## Distribution model (two phases — see DECISIONS.md 2026-04-18)

**Phase A — Private beta (near-term).** Repo stays private. Signed `.exe`
hosted on `andrewstaker.com` (unlisted or token-gated URL). 5–30 trusted
testers, recruited by the founder directly. No forum post, no auto-update.
Purpose: validate the install flow and surface bugs with people who
tolerate rough edges.

**Phase B — Public launch (this document).** Repo flipped public. `.exe`
migrates to GitHub Releases as the canonical source. Forum post goes up.
Auto-update (P5-007) activates.

The gate below is for **Phase B**. Private-beta distribution can start as
soon as P5-002/003/004 work on a clean VM; it does not need legal, Fractal
outreach, or the full polish list below.

---

## Release-readiness gate for public launch (must all be ✅ before posting)

**Packaging + install:**
- [ ] P5-001 — packager choice documented in DECISIONS.md
- [ ] P5-002 — signed Windows `.exe` boots the MCP server on a clean Windows 11 VM with no Node installed
- [ ] P5-003 — installer writes `claude_desktop_config.json` automatically; user never opens a JSON file
- [ ] P5-004 — AM4 USB-driver prerequisite check with actionable message (not a stack trace)
- [ ] P5-005 — signed build does not trip SmartScreen on a fresh Windows 11 install
- [ ] P5-007 — auto-update polling pointed at GitHub Releases API

**Legal + outreach:**
- [ ] Fractal conversation held (see `docs/FRACTAL-OUTREACH.md`). Their response (or no-response-after-N-days) logged in `DECISIONS.md`.
- [ ] Trademark pass: README non-endorsement language, project name defensible under descriptive fair use.
- [ ] License picked and committed (P5-010 — MIT or Apache-2.0).
- [ ] Reverse-engineering stance documented (interop, documented SysEx surface, user owns the hardware).

**Repo hygiene:**
- [ ] Private-beta testers have reported no install blockers for 2+ weeks
- [ ] Public-facing READMEs polished (no WIP comments, no personal paths, no embarrassing test fixtures)
- [ ] `.gitignore` audit complete — no accidental commit of captures with sensitive data
- [ ] Repo flipped from private to public
- [ ] Binaries migrated from andrewstaker.com to GitHub Releases

**Demo asset:**
- [ ] End-to-end smoke test recorded as a short GIF (install → ask Claude → AM4 display updates)

Until every box is ticked, this doc is planning material, not copy.

---

## Post structure

Post the bones first — muscle flex with a working demo GIF at the top.
Forum readers skim, so lead with evidence, then deliver details.

### 1. What this is (1-2 sentences + demo GIF)

Lead with the working demo. No preamble, no credentials. Example:

> **AM4 Tone Agent** — a local MCP server that lets you describe a tone
> to Claude Desktop and have it land on your AM4.
>
> *[GIF: Claude Desktop conversation on one side, AM4 display updating on the other as the preset takes shape.]*

### 2. Requirements

- Fractal AM4 (obviously) — Axe-Fx II XL+ and the III family are on the
  roadmap, see below.
- Windows 10 / 11 (macOS + Linux follow).
- **Fractal AM4 USB driver** installed
  ([Fractal downloads page](https://www.fractalaudio.com/am4-downloads/)).
- **Claude Desktop** installed
  ([claude.ai/download](https://claude.ai/download)).
- Claude.ai account. Works on **Free**, but iterative tone-building hits
  message caps fast — **Pro/Teams is recommended** for real workflow.

### 3. Install (3 clicks)

1. Download the signed `am4-tone-agent-setup.exe` from the [latest release](https://github.com/<user>/am4-tone-agent/releases/latest) on GitHub.
2. Run it. The installer registers the MCP server with Claude Desktop
   automatically — you never edit JSON.
3. Restart Claude Desktop if it was running when you installed.

> **SmartScreen note** *(first-release only, until signing reputation warms up)*: Windows may warn you about
> "an unrecognized publisher." Click "More info" → "Run anyway." The
> build is signed; SmartScreen just hasn't seen enough downloads yet to
> trust the certificate.

### 4. Verify it's working

- Open Claude Desktop → the AM4 tool should show in the tool panel
  (sidebar / tool button depending on your version).
- Ask: *"What preset is on my AM4?"*
- Claude should reply with the current preset's name, read live from
  the device.

If nothing happens, jump to the **Troubleshooting** section below.

### 5. Your first build

Start with a 3-line ask and let Claude do the work:

> *"Build a clean Fender tone with a touch of spring reverb on Z04."*

Watch the AM4 display update as Claude places blocks, sets parameters,
and saves to the scratch location. Then iterate in plain English —
*"make the reverb a bit bigger"*, *"swap the Twin for a Deluxe"*,
*"give me a cleaner channel on scene 2"*.

### 6. What it can do today

Short bulleted list of the current toolset, drawn from
`src/server/index.ts` at ship time. Current candidates (update as
Phase 1/2 wraps):

- Read current preset name + block layout.
- Apply a full preset in one call (blocks + parameters).
- Save to Z04 (scratch location — factory locations are hard-gated
  until BK-008 lands).
- Per-scene bypass + channel state (once BK-010 wraps).
- Rename presets and scenes (once BK-011 wraps).

### 7. What it can't do (yet)

Be honest. Forum readers will find the limits fast; owning them up
front beats them surfacing as bug reports.

- Audition loop (Claude playing to you) — AM4 has no playback path.
  User plays; Claude listens to description.
- Write to factory slots (A01..Z03) — safety-gated.
- Full preset library browsing UI — planned, not built.
- Axe-Fx II / III support — on the roadmap.

### 8. Troubleshooting (top 4 failures)

- **AM4 not listed in the tool panel.** Confirm the USB driver is
  installed; unplug/replug; try `reconnect_midi` from Claude Desktop.
- **Claude says "no AM4 found".** Another app (AM4-Edit, MIDI-OX) may
  hold the port; close it and try again.
- **SmartScreen blocks the installer.** See install step 3.
- **Writes don't land.** Make sure Z04 is loaded; reads/writes to
  other locations are gated.

Detailed diagnostics live in the GitHub README's Troubleshooting section.

### 9. Roadmap — what's next

- **Axe-Fx II XL+** (founder-owned, capture-based RE already planned).
- **Axe-Fx III / FM9 / FM3 / VP4** — community beta once the II
  protocol work generalises. **Looking for beta testers** when that
  phase opens.
- **Roland/Boss family** (RC-505 MKII / VE-500 / SPD-SX / JD-Xi) —
  separate effort, broadens the project beyond Fractal.

### 10. License + non-endorsement

- Licensed under [MIT or Apache-2.0] (per P5-010).
- Unaffiliated community tool. "Fractal Audio" and "AM4" are Fractal's
  trademarks. This project controls a device the user owns via the
  documented SysEx surface that Fractal publishes.

### 11. Feedback / contributions

- Bug reports + feature requests: GitHub issues.
- Discussions: this forum thread.
- Source + roadmap: GitHub repo (link).

---

## Voice / tone notes

- **Forum register, not marketing copy.** Fractal forum is
  engineering-literate guitarists. Under-promise, over-demonstrate.
- **Lead with evidence.** GIF at the top. No "revolutionary AI-powered
  assistant" language.
- **Own the limits.** Section 7 is as important as Section 5.
- **No "beta" qualifier at launch unless genuinely beta.** If it ships
  as v0.1.0 and works end-to-end on a clean VM, call it v0.1.0. If
  anything is hand-wavy, delay the post.
- **Don't bait-post.** Don't trash-talk Legend's thread or AI skepticism.
  Just ship something that works and let the artifact speak.

## What not to include

- Architecture deep-dives (interested users will follow the GitHub link).
- Session-by-session RE history (SESSIONS.md is in the repo for that).
- Promises about timelines on other devices.
- Screenshots of code. Screenshots of the AM4 display changing are
  worth 100x more.
