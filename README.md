# Virlow for Codex

A Codex plugin that connects Codex to [Virlow](https://virlow.com), the
end-to-end encrypted workspace for notes and connected ideas, and makes
memory part of the routine: Codex checks what Virlow knows at the start of a
task, and is reminded to save what is worth keeping before it stops.

It is the Codex sibling of
[Virlow for Claude Code](https://github.com/batalabs/virlow-claude-plugin)
and works the same way: the same local connector, the same memory rules, and
small hooks that remind the model to recall and to save.

Full setup guide: [virlow.com/ai-connections.html](https://virlow.com/ai-connections.html).

This plugin is installed from this repository, not from the public plugin
directory: it uses lifecycle hooks, and plugins with hooks are not listed
there.

## Requirements

- Codex CLI, or Codex in the ChatGPT desktop app. The IDE extension does not
  support plugins.
- Node.js 20 or later on your `PATH`. The connector runs with
  `npx -y virlow-mcp@latest`, and the hooks run with `node`.
- A Virlow account. Saving memories needs Virlow Pro.

## Install

Add this repository as a plugin marketplace:

```
codex plugin marketplace add batalabs/virlow-codex-plugin
```

Then install the plugin:

- **Codex CLI**: start `codex`, type `/plugins`, switch to the **Virlow**
  marketplace tab, open **Virlow** and install it.
- **ChatGPT desktop app**: open the Plugins Directory, choose the **Virlow**
  marketplace, and install **Virlow**.

Start a new Codex session after installing, so the skills, the connector and
the hooks load.

### Trust the hooks

Codex does not run a plugin's hooks until you review and trust them. At the
start of the first session, Codex warns that hooks need review: type
`/hooks`, look over the five Virlow hooks (they all run one script,
[`plugins/virlow/hooks/virlow-memory.mjs`](plugins/virlow/hooks/virlow-memory.mjs)),
and trust them. Codex asks again whenever a hook definition changes in an
update. Without trust, the connector and skills still work; memory is just
less automatic.

### Unlock your vault

Ask Codex to unlock Virlow. The connector opens a form in your browser: sign
in to your Virlow account, complete two-factor authentication if it is on,
and enter your master password there. Never type your master password in
chat or put it in any configuration. The encryption key is derived on your
machine; your master password is not sent to Virlow's API. Ask Codex to call
`status` to check which account is unlocked.

### Turn on AI memories

Memories are opt-in. In Virlow on the web, open **Settings → Security** and
turn on **AI memories**. Saving memories needs **Virlow Pro**. Every memory
is an ordinary encrypted note: you can read, edit and delete each one in
Virlow, under Memories.

## What it does

| Codex event | What happens |
|---|---|
| `SessionStart` (startup, resume, clear, compact) | Codex is told this project's memory namespace (the git repository's folder name, or the working folder's) and asked to call `search_memory` at the start of a task. |
| `UserPromptSubmit` | Counts the session's turns. Adds nothing to the prompt. |
| `PostToolUse` on `add_memory` or `update_memory` | Marks the session as having saved a memory. |
| `Stop` | If the session had at least three turns and saved nothing, Codex is asked once to save anything durable before it stops. It fires at most once per session and cannot loop. |
| `SessionEnd` | Deletes the session's counters. |

It also includes:

- **The Virlow connector** (`npx -y virlow-mcp@latest`, a local stdio MCP
  server), so installing the plugin is the whole setup.
- **The `virlow-memory` skill**: recall with `search_memory` at the start of
  a task, save durable facts you share and say `Saved to Virlow: ...` each
  time, respect "don't remember this", and never store secrets.
- **The `tidy` skill**: link, merge and resolve your memories with
  `memory_health`. Ask Codex to tidy your Virlow memories, or type `$` and
  pick Virlow's `tidy` skill. It does what `/virlow:tidy` does in Claude Code.

## What the hooks do not do

The hooks are one small script with no dependencies. It:

- never reads the session transcript,
- never calls Virlow or any other network service,
- never sees note content, memories, your master password or any key,
- only keeps a turn count and two flags per session, in the plugin's data
  directory, and deletes them when the session ends,
- never fails a turn: on any error it exits quietly and adds nothing.

All reading and writing of memories happens in the connector, on your
machine, through its tools. The connector refuses to save anything that
looks like a password, key or card number, and the skill tells Codex never to
save credentials, health details, financial account numbers or government ID
numbers.

## Privacy and security

- Your notes and memories are encrypted on your machine with a key derived
  from your master password. The connector decrypts them locally, for the
  session you unlocked, and Codex sees only what its tools return.
- For notes, the connector reaches only the workspaces where you turned on
  **Expose to MCP** in Virlow. Memories are separate: they need **AI
  memories** turned on.
- Nothing in this repository contains or asks for credentials. You sign in
  and unlock in your browser, on a local page the connector opens.
- How Virlow encrypts and what it can and cannot read:
  [virlow.com/security.html](https://virlow.com/security.html). What Virlow
  collects: [virlow.com/privacy.html](https://virlow.com/privacy.html).

## Settings

- `VIRLOW_MEMORY_HOOKS=off`, set before starting Codex, turns the automatic
  memory hooks off and keeps the connector and skills.
- To turn off a single hook, use `/hooks`. To turn all Codex hooks off, set
  `hooks = false` under `[features]` in `~/.codex/config.toml`.
- Plugin hooks run only where the script exists, so they work in Codex CLI
  and the ChatGPT desktop app on your computer, not in cloud-orchestrated
  ChatGPT Work.

## Update

```
codex plugin marketplace upgrade virlow
```

Then start a new Codex session. If a hook changed, Codex asks you to review
it again in `/hooks`. The connector always runs the latest `virlow-mcp`.

## Uninstall

Open `/plugins` in Codex CLI (or the Plugins Directory in the ChatGPT desktop
app), open Virlow and choose **Uninstall plugin**. To forget the marketplace
too:

```
codex plugin marketplace remove virlow
```

Uninstalling removes the plugin from Codex. Your notes and memories stay in
Virlow until you delete them there.

## Develop

```
npm test
```

The tests run the hook script for every event, check the manifest,
`mcp.json` and hooks against the Agent Plugins schemas and Codex's hook
rules, and scan the repository for anything that looks like a secret.

To try a local checkout, add it as a marketplace from its folder:

```
codex plugin marketplace add ./virlow-codex-plugin
```

Run the hook by hand with the input Codex sends:

```bash
cd plugins/virlow/hooks
echo '{"session_id":"demo","cwd":"/work/atlas"}' | node virlow-memory.mjs session-start
for i in 1 2 3; do echo '{"session_id":"demo"}' | node virlow-memory.mjs prompt; done
echo '{"session_id":"demo","cwd":"/work/atlas","stop_hook_active":false}' | node virlow-memory.mjs stop
```

The last command prints the save reminder as `{"decision":"block",...}`. Run
it again and it prints nothing: the reminder fires once per session.

## Layout

```
.agents/plugins/marketplace.json   the marketplace Codex reads from this repo
plugins/virlow/
  plugin.json                      Agent Plugins manifest, with Codex settings
  mcp.json                         the local Virlow connector
  skills/virlow-memory/SKILL.md    when to recall and save, and what never to save
  skills/tidy/SKILL.md             tidy memories
  hooks/hooks.json                 the five hooks
  hooks/virlow-memory.mjs          the one hook script
  assets/logo.png
```

## Support

Questions and problems: [virlow.com/support.html](https://virlow.com/support.html).
To report a security issue, write to team@virlow.com instead of opening a
public issue.

## License

Copyright Bata Labs LLC. This repository is public so you can read
everything the plugin runs. It does not carry an open-source license.
