<div align="center">

# qq-xiaoyu

**An AI that actually behaves like a group-chat member — not a support bot.**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-339933?logo=node.js&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-beta-orange)](CHANGELOG.md)
[![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20Node.js-lightgrey)](#prerequisites)

[中文](README.md) · [Quick start](#quick-start) · [Architecture](docs/ARCHITECTURE.md)

</div>

---

`qq-xiaoyu` bridges a QQ account to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): messages from QQ groups and DMs become agent input, and the agent's replies — including stickers, quotes and multi-part messages — go back to QQ.

Wiring an LLM to QQ is a weekend project. Making it **not feel like a bot** is the actual work:

| Ordinary bot | qq-xiaoyu |
| --- | --- |
| Replies to everything | Decides whether to reply at all; can stay silent or answer with a single "?" |
| One long paragraph | Splits into 1–5 short messages with human-ish timing |
| Goldfish memory | Per-group *study notebook* plus cross-group memory — remembers people and running jokes |
| Online 24/7 | Has a sleep schedule and wakes on conditions (@mention, name, question, idle) |
| "Hello, I am an AI assistant" | Deflects "are you a bot?" and never speaks in system-receipt voice |
| Instant replies | Waits for the other person to finish; tells you to sleep at 1 a.m. |

> "Xiaoyu" is one concrete persona: a 17-year-old studying abroad, short sentences, loves anime. The persona is just a Markdown file — swap it, the machinery stays.

## How it works

```
QQ client
   │  (your account, QR login)
   ▼
SnowLuma gateway  ── OneBot v11 (WS + HTTP) ──►  qq-xiaoyu bridge
   ▲                                                 │
   │                                                 │ cookie auth / slash RPC / remote.mux
   │                                                 ▼
   └───────────── messages, stickers, quotes ◄── DeepSeek Harness
                                                     │
                                                     ▼
                                                  model
```

Three layers, three jobs:

- **Bridge (this repo)** — access control, session mapping, message splitting and pacing, media, tool surface, cost ledger, local console.
- **DSH** — the actual agent loop: sessions, context, tool calls, approvals, model selection.
- **SnowLuma** — the OneBot gateway hooked into the QQ client. **Not bundled, not started, not redistributed here** (see [LICENSE](LICENSE)).

The core idea: **"when to speak" is separate from "what to say."** Rules decide whether to wake the agent; the agent decides what to say, in how many messages, whether to quote, and whether to go back to sleep.

## Features

**Human-like**

- 🧠 **Study notebook** — the agent appends observations to a per-group notebook and reads it back on the next wake
- 🌙 **Wake scheduling** — the agent chooses how long to sleep and which events should wake it
- ✂️ **Multi-part replies** — one answer becomes several short messages with randomized gaps
- 🖼️ **Stickers** — collect, nickname, and send them by meaning; replies with a sticker when someone sends one
- 💬 **Quoted replies** — reply to a specific message, not always the newest one
- 🎭 **Two-layer prompts** — simulation layer (tools, splitting, pacing) plus persona layer (`roles/*.md`, injected per message)
- 📓 **Situation brief** — a de-identified "who my owner is, which groups I'm in" note to keep the persona consistent

**Capable**

- 🤖 Four modes: plain chat / owner-only full-agent / gen-1 simulation / gen-2 "everything is a tool"
- 🛠️ The agent calls tools to read unread messages, search history, send text, stickers, pokes and quotes
- ❓ `ask_user_question` is forwarded to QQ; your reply is the answer
- ✅ Tool approvals can be granted or denied from QQ
- 🔍 Web search (shared with DSH, Bing fallback) and SSRF-guarded fetching
- 🗣️ Optional voice sending (off by default)

**Operable**

- 📊 **Local console** (`http://127.0.0.1:3100`) with ten pages: overview, sessions, personas, both simulation generations, slang, token spend, security, debug
- 💰 **Cost dashboard** — drill down per group, per friend, per turn, with peak/off-peak pricing
- 🩺 **Human-likeness audit** — scores the bot's own messages (length variance, short-reply ratio, repetition, latency)
- 🛡️ **Guardian** — single-shot watchdog rounds; restarts the bridge when DSH, the gateway or the upstream hook goes stale
- 🔒 **Privacy scan** — blocks real QQ numbers, local paths and tokens before commit (`npm run privacy-scan`)

## Modes

| Mode | Audience | Behaviour |
| --- | --- | --- |
| `chat` | whitelisted groups / DMs | Chat only, minimal tool surface |
| `closed-agent` | owner DM only | Full tool set — remote-control DSH from QQ |
| `reserved` | gen-1 simulation | State machine + space-delimited splitting + `[SILENT]` |
| `reserved2` | gen-2 simulation (recommended) | Everything is a tool; the agent polls, speaks, waits, reschedules itself |

## Quick start

### Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js ≥ 22.13 | The bridge itself |
| DeepSeek Harness | Installed and running (default `http://127.0.0.1:3080`) |
| SnowLuma | Install and log in yourself. This project does **not** install or launch it |
| A spare QQ account | Don't experiment with your main account |

```bash
git clone https://github.com/Coomusk/qq-xiaoyu.git
cd qq-xiaoyu
npm install                      # postinstall patches @snowluma/sdk's ESM packaging bug

cp config.example.json config.json
#   fill in `snowluma`, `allow.private` / `allow.groups`, `ownerQQ`

node scripts/setup-dsh.mjs       # install DSH presets + MCP servers, then RESTART DSH
npm start                        # or start.bat on Windows (auto-restart on crash)
```

Then send a message to the bot account on QQ. `SnowLuma 已连接` in the log means you're live.

> ⚠️ The two classic "no response" causes: (1) you skipped `setup-dsh.mjs` — the bridge deliberately refuses to create sessions without the safe preset; (2) your whitelists are empty — the default is fail-closed.
>
> Full setup and troubleshooting: **[docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md)**.

## Writing a persona

A persona is one Markdown file in `roles/`, named after the character:

```markdown
You are Xiaoyu. Everyone in the group calls you that. A 17-year-old girl
studying abroad, not a great student. You are an ordinary member of this
QQ group — never call yourself an assistant, never explain the setup.

[How you talk]
- Type like you're on your phone. Half your replies are under 10 characters.
- Short punctuation, long thoughts split into two messages.
- Don't answer everything. If you have nothing to add, send "?" or nothing.
```

Three rules of thumb (details in [docs/PERSONA.md](docs/PERSONA.md)):

1. A persona card describes **who you are**, never **how to use tools** — tool instructions belong to the preset and will conflict across generations
2. **Shorter is more human** — keep it to 3000–5000 characters; it rides along with every message
3. **"Don't" beats "do"** — don't probe, don't justify, don't explain, don't repeat

Three examples ship in `roles/`: a group member, a tsundere assistant, a small whale.

## Safety and compliance

Defaults are conservative — and that conservatism costs you responsiveness. Read [RULES.md](RULES.md) first.

- **Access**: independent group/DM allow- and deny-lists, fail-closed by default
- **Tool surface**: QQ sessions get a safe subset — sends are whitelist-enforced, file paths stay inside the repo, no arbitrary shell
- **Egress**: SSRF-guarded downloads (private ranges, DNS rebinding), IPv4-first with per-address failover
- **At rest**: `config.json`, `state/`, `audio/` are git-ignored; `privacy-scan` blocks real identifiers before commit

⚠️ Stated plainly:

- Unofficial protocol tools **may violate the platform's terms of service** and get an account restricted. Your risk.
- Messages in your groups — **including other people's messages** — go to whichever model provider you configure.
- Slang auto-research is on by default and sends words extracted from group chat to a search backend. Turn off `slang.autoResearch` if that matters to you.
- SnowLuma is a source-available, **non-commercial** third-party project. This repo only speaks OneBot to it; it is not included or redistributed.

The full data-egress inventory and license boundaries are in [LICENSE](LICENSE) and [docs/guides/PRIVACY.md](docs/guides/PRIVACY.md).

## Known limitations

- Incoming voice/video is placeholder text (no transcription); sending voice needs your own audio files
- Replies are sent when the turn ends — no token-by-token streaming to QQ
- Ops scripts (guardian, panel, restart) are Windows/PowerShell; the bridge itself is plain Node.js
- Some regression suites are red during an in-progress refactor — see [KNOWN_ISSUES.md](KNOWN_ISSUES.md)
- Single instance: one bridge process per QQ account

## Contributing

Issues and PRs welcome. Before you push:

```bash
npm run test:audit      # offline regression, no QQ/SnowLuma needed
npm run privacy-scan    # make sure nothing personal leaks
```

Hard rule: **never commit real QQ numbers, real chat logs, tokens or local paths.** See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

- [MIT](LICENSE) © 2026 qq-xiaoyu contributors
- Derived from [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) (MIT)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT)
- [SnowLuma](https://github.com/SnowLuma/SnowLuma) — non-OSI, non-commercial; not redistributed here

> For study and research only. Not affiliated with Tencent or QQ.
