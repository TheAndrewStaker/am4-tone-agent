# Fractal Audio — Outreach Plan

> Plan for contacting Fractal Audio before the public launch of AM4
> Tone Agent. Goal: give them a heads-up and a demo *before* the forum
> post lands, framed as interop using their published SysEx surface —
> not as a stealth announcement. Success looks like "no objections,
> possibly quiet encouragement"; acceptable looks like "silence after
> N days = inform and launch." See `DECISIONS.md` 2026-04-18 for why
> this gate exists.

---

## Why reach out at all

Three reasons, in order:

1. **Respect + goodwill.** Fractal is small and community-oriented.
   Letting a working demo land in their inbox before the forum post
   shows we treat the relationship as a long-term one, not a stunt.
2. **Reduce legal surface.** A documented "they knew, they didn't
   object" softens any future question about whether the project was
   adversarial or hidden.
3. **Signal-boost potential.** Positive Fractal response opens the
   door to ship updates about Axe-Fx II (BK-014) / III / FM9 / FM3 /
   VP4 (BK-015) as a supported community tool, not a guerrilla one.

## When to send

**Not before** the end-to-end install flow works on a clean Windows 11
VM (P5-002 acceptance + P5-003 auto-config Claude Desktop). They need
to see something that works; a demo video of a working flow, not a
pitch deck.

**Not after** the public forum post. The sequence is:

1. Private beta runs. Install + basic workflow proven.
2. Demo video recorded (60-90 seconds, no voiceover required).
3. **Send this email.**
4. Wait up to 10 business days.
5. Public forum post goes up — incorporating any Fractal feedback.

## Who to contact

Blank until populated. Targets to identify:

| Role | Name | Contact | Notes |
|------|------|---------|-------|
| Fractal Audio developer advocate / community lead | _TBD_ | _TBD_ | Usually the right first door — knows the forum culture, handles third-party questions. |
| Senior engineer (if identifiable via forum or LinkedIn) | _TBD_ | _TBD_ | Only if a warm intro exists; otherwise too cold. |
| General support channel | support@fractalaudio.com (verify) | — | Fallback if no named contact surfaces. Lower signal. |

**Avoid:** posting the outreach publicly on the forum before the
private email lands. That forces Fractal into a public response
posture, which is the opposite of what we want.

## Email draft (v0 — iterate before sending)

**Subject:** Third-party interop tool for the AM4 — quick demo + a
question

> Hi [name],
>
> I'm a musician and developer (and a happy AM4 owner). Over the last
> few weeks I've been building a small third-party tool called **AM4
> Tone Agent** — a local MCP server that lets me describe a tone to
> Claude Desktop in plain English and have it configure my AM4's
> working buffer + save it to a preset location. It uses the SysEx
> surface your Axe-Fx III third-party MIDI PDF documents, which AM4
> shares, plus a small amount of AM4-Edit traffic capture to decode
> the extensions above block ID 200.
>
> Short demo (unlisted): [link to 90-second video, Loom or YouTube].
>
> Two reasons I'm writing before I share this more widely:
>
> 1. **Heads-up.** I'd rather Fractal know about this from me than
>    from a forum thread. The tool is non-commercial, carries explicit
>    non-endorsement language, and is scoped to a device the user
>    already owns.
> 2. **A question.** Is there anything you'd like me to change,
>    emphasise, or omit before I post about it publicly on
>    forum.fractalaudio.com? I'm happy to adjust naming, scope,
>    framing, or packaging to stay within whatever boundaries make
>    sense to you.
>
> I'm planning to make a community post in the next 1–2 weeks either
> way, but I'd much rather ship it with your awareness (and ideally
> feedback) than without.
>
> Happy to hop on a call, trade emails, or hand you a test build —
> whichever's easiest.
>
> Thanks for the AM4. Genuinely a delight to build against.
>
> — Andrew Staker
> [andrewstaker.com] | [GitHub handle when repo goes public]

## Response handling

### If they reply positively

- Log the reply (or summary thereof) in `DECISIONS.md` with date.
- Incorporate any requested naming / scope adjustments.
- Mention in the forum post that Fractal was given advance notice.
  Do NOT claim endorsement or partnership unless they explicitly
  grant that. Exact language: *"Shared with Fractal Audio in advance
  of this post as a courtesy."*

### If they reply with concerns

- Address them. Common asks to prepare for:
  - **Naming change** (e.g. drop "AM4" from the project title). Have
    a fallback name in your back pocket: e.g. `Fractal Tone Agent`
    (broader, but invites later Axe-Fx II / III extensions).
  - **Scope restriction** (e.g. don't publish the SysEx decode notes).
    SYSEX-MAP.md could move to private-only; the library still works.
  - **Delay request.** Honor it within reason.
- If they ask to talk: great. Aim for a short video call.

### If they don't reply

- Wait 10 business days from send.
- Send one short follow-up ("bumping this for your attention before
  I post publicly").
- Wait another 5 business days.
- Proceed with public launch. Log the silence in `DECISIONS.md`
  with the send + follow-up dates.

### If they object

- Take it seriously. Pause the public launch.
- Understand the specific objection. If it's narrow (one word in
  the name, one scope item), adjust and re-send. If it's broad
  ("we don't want any third-party tools for AM4"), that's a harder
  conversation — at that point, the private-beta-only path may be
  the right permanent resting place until the relationship changes.
- Never ship public over an explicit objection without a clean
  counter-argument that respects their position.

## What this outreach is NOT

- Not asking for a partnership, endorsement, co-marketing, or API access.
- Not asking for documentation beyond what they publish.
- Not an offer to license the code to Fractal (that's a later, separate
  conversation if the tool matters).
- Not a request for hardware, firmware, or developer credentials.
