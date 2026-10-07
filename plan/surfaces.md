# Surfaces — CLI, API, UI

Human control and visibility. The engine is useful headless (CLI), operable (HTTP API), and reviewable (UI). M8 builds the API and UI; the CLI ships from M0.

---

## 1. CLI

```
loom blueprint validate <file>                 # validate a Blueprint; exit non-zero on error
loom run --task "..." --repo <path> [flags]    # start a run
loom status <runId>                            # agents, branches, shas, cost, timings
loom diff <runId> [--agent <id>]               # combined or per-agent diff
loom merge <runId> --agent <id>                # apply one branch to the base
loom clean <runId> [--branches]                # remove worktrees (and optionally branches)
loom worktrees                                 # list live worktrees
loom bench --suite <dir> [--blueprint <file>]  # run the bench, print the score
loom tune --cycles N [--blueprint <file>]      # run the tuner loop
```

`loom run` flags:

| Flag | Default | Meaning |
|---|---|---|
| `--repo <path>` | cwd | The base repository. |
| `--blueprint <file>` | `blueprint.json` | The Blueprint to run. |
| `--task <text>` | required | The task. |
| `--agents <n>` | Blueprint default | Shorthand for `budgets.maxConcurrentAgents`. |
| `--effort <tier>` | `standard` | `quick` \| `standard` \| `thorough`, injected into the entry role. |
| `--model-override <role=profile>` | — | Repeatable. |
| `--base <ref>` | `HEAD` | Base ref, resolved to a sha. |
| `--json` | off | Machine-readable output. |
| `--dry-run` | off | Plan the run without executing. |

---

## 2. HTTP API

All JSON. The API is the tuner's interface to the engine, so it is a first-class contract, not a UI detail.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/runs` | POST | Start a run (`{ task, repo, blueprint, base, effort, modelOverrides }`). |
| `/api/runs` | GET | List runs, newest first. |
| `/api/runs/:id` | GET | Run status: agents, branches, shas, cost, timings. |
| `/api/runs/:id/events` | GET | Paged event stream (`offset`, `limit`). |
| `/api/runs/:id/diff` | GET | Combined or per-agent diff (`?agent=`). |
| `/api/runs/:id/merge` | POST | Merge a branch (`{ agent }`). |
| `/api/runs/:id/cancel` | POST | Cancel the run and its children. |
| `/api/runs/:id/steer` | POST | Inject an operator message at the next safe point. |
| `/api/blueprint` | GET/PUT | Read/replace the active Blueprint. |
| `/api/config` | GET | Rendered display metadata (roles, tools, labels). |
| `/api/ws/runs/:id` | WS | Live event stream for one run. |

---

## 3. Web UI

One screen, three regions:

- **Runs** — list with status, task, cost, duration; search and filter; selection persisted in the URL.
- **Run view** — the live view: agent tree/DAG, per-agent status, live event feed, cost and elapsed strips, and a **diff review** panel (the highest-value surface — what did the run actually change).
- **Controls** — start a run, cancel, steer, merge a branch, revert.

Optional: a **dashboard** with cost/latency/trace trends across runs.

Rendering rule (carried over from the reference implementation, which got this right): machine fields (ids, counts, costs, timestamps, statuses) are rendered as text nodes; agent-authored prose is rendered as sanitized Markdown with a strict allowlist, never as raw HTML.

---

## 4. Data layout

```
<repo>/.loom/                              # git-excluded
├── runs/<runId>/
│   ├── run.json                           # manifest
│   ├── events.jsonl                       # append-only event stream
│   └── agents/<agentId>/
│       ├── transcript.jsonl
│       └── result.json
├── worktrees/<runId>/<agentId>/           # git worktrees
└── tuner/                             # baseline, branches, history, reports
```

The **manifest** is the run's contract:

```jsonc
{
  "runId": "20261007T142233Z-a1b2c3",
  "status": "success",
  "baseRef": "HEAD",
  "baseSha": "9f2c1ab",
  "baseDirty": false,
  "blueprintHash": "sha256:...",
  "startedAt": "2026-10-07T14:22:33Z",
  "finishedAt": "2026-10-07T14:31:02Z",
  "cost": { "usd": 0.412, "inputTokens": 184233, "outputTokens": 22110 },
  "agents": [
    {
      "agentId": "coder-1-2",
      "role": "coder",
      "model": "worker",
      "parent": "orchestrator-0-1",
      "branch": "loom/20261007T142233Z-a1b2c3/coder-1-2",
      "sha": "3b7e9d0",
      "status": "success",
      "startedAt": "2026-10-07T14:22:35Z",
      "finishedAt": "2026-10-07T14:26:10Z"
    }
  ]
}
```

---

## 5. Acceptance tests (M8)

- A run is startable, watchable, reviewable (diff), and revertible from the UI.
- Traces expose agent → turn → tool spans with per-span cost.
- The UI has no JavaScript build step, or exactly one documented build step.
- The run list survives a page reload with its selection intact.
