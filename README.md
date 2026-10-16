<h1 align="center">pi-orchestrator</h1>

<p align="center">
  <em>Role-based orchestration extension that forces the Pi Coding Agent to delegate through subagents instead of skipping them.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Pi-Coding%20Agent-0969da?style=flat-square" alt="Pi Coding Agent" />
  <img src="https://img.shields.io/badge/Pipeline-Research%20%E2%86%92%20Code%20%E2%86%92%20Audit-2ea44f?style=flat-square" alt="Pipeline" />
  <img src="https://img.shields.io/badge/Roles-4%20configurable-8250df?style=flat-square" alt="Roles" />
  <img src="https://img.shields.io/badge/License-MIT-bf8700?style=flat-square" alt="License" />
</p>

<p align="center">
  <img src="assets/banner.svg" alt="pi-orchestrator banner" width="850" />
</p>

---

## Overview

**pi-orchestrator** is a Pi Coding Agent extension that turns delegation from a *suggestion* into *enforced routing*.

A rule written in `AGENTS.md` is soft context: the main model may read it and still decide to do everything itself. This extension closes that gap with three layers — a system-prompt rule injected every turn, a hard `orchestrate` tool that runs the whole pipeline itself, and a tool-call gate that blocks the manager from writing code while the pipeline owns the change.

### Features
- **On/Off Toggle:** `/orchestrator` switches mode instantly; the state persists in `~/.pi/agent/orchestrator.json`.
- **Four Configurable Roles:** Context engine, lead coder, security specialist, and QA — each with its own model and thinking level.
- **Enforced Pipeline:** `orchestrate` runs research → implement → security + QA in parallel → at most one fix round, and returns one consolidated report.
- **Write Gate:** While mode is ON and no verified pipeline run has completed, `edit`, `write`, and direct `worker` launches are blocked at the tool-call boundary.
- **Searchable Model Picker:** Pi's default selector renders every option without scrolling, so long model lists get clipped. The picker in this extension scrolls, filters as you type, and returns to the menu after a pick.
- **Tab-Cycling Rows:** `Tab` cycles the focused row — flip the on/off toggle or step through thinking levels without leaving the menu.
- **Fail-Open on Misconfiguration:** A broken `pi-subagents` bridge releases the gate instead of wedging the session.
- **Child-Process Guard:** Subagent children spawn their own Pi process; the extension detects `PI_SUBAGENT_CHILD` and stays inert there.
- **Dependency Gate:** `pi-subagents` is required, so the extension probes the bridge and refuses to turn ON without it, warns on startup, and clears a stale `enabled: true`.

---

## Architecture

| Role | Default Agent | Stage | Responsibility |
|:---|:---|:---|:---|
| **Manager** | *main session* | routes + accepts | Picks the models, hands off the task, synthesizes the report, makes the final call. |
| **Context engine** | `researcher` | 1 | Gathers the files, facts, and constraints. Read-only. |
| **Lead coder** | `worker` | 2 | Implements from that context. The only writer. |
| **Security specialist** | `reviewer` | 3 | Audits the diff for injection, authorization, secrets, and unsafe input handling. |
| **QA** | `reviewer` | 3 | Runs the tests and reports pass/fail evidence. |

Stages 3 run **in parallel**; a `blocked` verdict from either reviewer buys exactly one fix round before the final answer.

---

## Enforcement Layers

1. **System prompt (advisory).** Every user turn, `before_agent_start` appends the pipeline rules to `systemPromptOptions.promptGuidelines`.
2. **`orchestrate` tool (structural).** The whole staged fan-out runs inside the tool, so the manager cannot forget the sequence — there is nothing to remember.
3. **`tool_call` gate (hard).** `edit`, `write`, and direct `worker` launches are rejected until a pipeline run reports explicit success.

> The gate deliberately fails **closed** on ambiguous completion payloads (editing stays blocked) and **open** when the RPC bridge is unavailable (editing is released).

---

## Installation

Install it as a **Pi package**: Pi clones the repo, reads the manifest, and loads the extension.

```bash
pi install git:github.com/andrraa/pi-orchestrator
```

Pin a revision when you want a frozen checkout (git tags and commits are pinned; untagged installs follow the default branch):

```bash
pi install git:github.com/andrraa/pi-orchestrator@v0.1.0
```

Or install from a local clone while developing:

```bash
pi install ./pi-orchestrator
```

### Managing the package

```bash
pi list                                   # confirm it is registered
pi update --extensions                    # reconcile the checkout
pi remove git:github.com/andrraa/pi-orchestrator
```

The declaration is written to `~/.pi/agent/settings.json`, or to `.pi/settings.json` with `--local` for a single project.

> **Remove any manual symlink first.** If you previously linked the extension into `~/.pi/agent/extensions/`, delete that symlink before installing — Pi discovers extensions in both places, and a leftover link loads the extension twice.

Requirements:

- **Pi Coding Agent** (`@earendil-works/pi-coding-agent`)
- **pi-subagents** package — the extension drives it over the in-process RPC event bus

Both are declared as `peerDependencies` and are supplied by the Pi host; the package ships no runtime dependencies of its own.

Restart Pi after installing. No build step is required: Pi loads the TypeScript through `jiti`.

### Missing dependency

`pi-subagents` is not optional: without a live bridge there is nothing to delegate to, so mode cannot be armed. When the package is absent or disabled:

```bash
pi install npm:pi-subagents   # then restart pi
```

The extension detects this by speaking the bridge's RPC — any reply, including an RPC-level error, proves the bridge is listening. A probe timeout is the only signal treated as "missing". In that state:

- the toggle row collapses to `OFF` and **Tab cannot turn mode ON**;
- the status row reads `pi-subagents: MISSING`;
- `/orchestrator` warns on open, and `/orchestrator on` is refused with the reason;
- a session that starts with a stale `enabled: true` is force-disabled and warned once.

This is a safety interlock, not decoration: a missing bridge also releases the write gate (see Enforcement Layers), so an unarmed mode is the honest state.

---

## Usage

Run `/orchestrator` in any Pi session:

```text
/orchestrator
```

### 1. Menu
```text
Orchestrator

  Type to search
> Enable orchestrator         OFF
  Manager model              9router-private/...
  Context engine             belum dipilih
  Lead coder                 9router-private/...
  Security specialist        belum dipilih
  QA                         9router-private/...
  Thinking Context engine    default
  Thinking Lead coder        default
  Thinking Security specialist  default
  Thinking QA                default
  pi-subagents: ok

  Type to search · Enter/Space to change · Esc to cancel
```

The menu scrolls, so every row stays reachable. It also has its own search: press `/` or just start typing to filter rows by name.

### 2. Row Behaviour

| Action | Key | Result |
|:---|:---|:---|
| Toggle ON/OFF | `Tab` or `Enter` | Flips the focused row and persists immediately. |
| Cycle thinking level | `Tab` | Steps `default → off → minimal → low → medium → high → xhigh → max → default`. |
| Pick a model | `Enter` on a model row | Opens the model picker. |
| Search rows | type any text | Filters the menu by row label. |
| Close | `Esc` | Returns to the prompt. |

`Tab` is the shortcut for "change the thing under the cursor" — it never moves focus out of the menu, so you can toggle on/off and walk the four thinking levels without re-opening the command.

### 3. Model Picker
```text
Lead coder [worker]

cari> glm
  → 9router-private/river/zai-org/GLM-5.3-Flash

  ketik mencari · ↑↓ pilih · enter simpan · esc batal
```

No pagination. The list scrolls, the current model is marked `✓`, and typing filters (case-insensitive substring, so `3.8` and `glm53` both work). Picking a model drops you back into the menu — the command does not exit — so you can set every role in one visit.

### 4. Running the pipeline
With mode ON, ask for a code change. The manager calls `orchestrate`, which returns:

```text
Stages: research -> implement -> security+QA (parallel) -> at most one fix round.
```

| Verdict | Meaning |
|:---|:---|
| `clean` | Both reviewers returned `clean` **and** both upstream stages succeeded. |
| `blocked` | Blockers remain after the fix round. |
| `fixed` | A fix round ran and succeeded. |
| `unverified` | The pipeline could not obtain a real verdict — treat as **not** verified. |

While the pipeline runs, `edit` / `write` are blocked. After a successful run, editing is unlocked until the next user turn.

---

<details>
<summary><strong>Configuration Reference</strong></summary>

Written to `~/.pi/agent/orchestrator.json`:

```json
{
  "enabled": true,
  "roles": {
    "context": "provider/model",
    "coder": "provider/model",
    "security": "provider/model",
    "qa": "provider/model"
  },
  "thinking": {
    "context": "",
    "coder": "high",
    "security": "",
    "qa": ""
  }
}
```

- **`thinking`** accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `""` for the model default. Unknown values normalize to `""`.
- The level is applied as a `:<level>` suffix on the child model string — `pi-subagents` treats a separate `thinking` field as watchdog-only.
- A missing `thinking` key, a malformed value, or an unreadable config file is tolerated: defaults are used and nothing throws.
</details>

<details>
<summary><strong>How the Delegation Bridge Works</strong></summary>

`ctx.executeTool("subagent", ...)` is **not** available to extensions — `pi-subagents` registers that tool as `exposure: "model-only"`, so calling it fails with `Tool subagent not found`.

This extension therefore uses the supported channel instead: an in-process event-bus RPC.

| Step | Channel / Value |
|:---|:---|
| Request | `subagents:rpc:v1:request` with `{ version: 1, requestId, method: "spawn", params }` |
| Reply | `subagents:rpc:v1:reply:<requestId>` |
| Terminal event | `subagent:async-complete` |

The run id is read from `reply.data.details.asyncId`. If a completion payload carries no text, a single `status` request corroborates it. No polling is used, every listener is unsubscribed on all paths, and the spawn reply has a 20-second timeout.
</details>

<details>
<summary><strong>Operational Notes</strong></summary>

- **Sleep vs. the watchdog.** `pi-subagents` enforces its child timeout against wall-clock time, including time the machine spent asleep. A laptop that idle-sleeps mid-pipeline will starve long-running children. Run long pipelines plugged in, or keep the machine awake with `caffeinate -i`.
- **Wall-clock ceilings.** The spawn reply times out after 20 seconds; the pipeline itself is abandoned after 45 minutes. An abandoned or aborted run never sets `verified`.
- **One writer at a time.** The coder role is the only stage allowed to modify files, and the fix round reuses that same role.
</details>

<details>
<summary><strong>Repository Layout</strong></summary>

```text
pi-orchestrator/
├── .gitattributes            # Enforces LF line endings across all platforms
├── .gitignore                # Ignores runtime caches and backups
├── README.md                 # Documentation
├── LICENSE                   # MIT License
├── package.json              # Pi package manifest (extensions + peer dependencies)
├── assets/
│   └── banner.svg            # README banner
└── extensions/
    └── orchestrator.ts       # /orchestrator command + orchestrate tool
```
</details>

---

## License

This project is licensed under the [MIT License](LICENSE).
