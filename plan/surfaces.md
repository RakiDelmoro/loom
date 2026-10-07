# Surfaces — CLI, API, UI

Human control and visibility. The engine is useful headless (CLI), operable (HTTP API), and reviewable (UI). M8 builds the API and UI; the CLI ships from M0.

---

## 1. CLI

```
loom blueprint validate <file>                 # validate a Blueprint; exit non-zero on error
loom run --task "..." [--repo <path>]          # start a run and wait for it
loom runs [--repo <path>]                      # list the runs recorded in a repository
loom status <runId>                            # agents, branches, shas, cost, timings
loom diff <runId> [--agent <id>]               # combined or per-agent diff
loom merge <runId> --agent <id>                # apply one branch to the base
loom undo <runId>                              # return the base to where the run started
loom clean <runId> [--branches]                # remove a run's worktrees (and optionally branches)
loom bench --suite <dir> [--split <s>] [--repetitions <n>]
loom tune [--repo <path>] [--config <file>]    # run the tuner loop
loom serve [--repo <path>] [--port <n>] [--host <addr>]
```

`loom run` flags:

| Flag | Default | Meaning |
|---|---|---|
| `--repo <path>` | cwd | The base repository. |
| `--blueprint <file>` | `loom.json` | The Blueprint to run. |
| `--deployment <file>` | `loom.deployment.json` | Providers, prices, credentials by environment name. |
| `--task <text>` | required | The task. |
| `--autonomy <level>` | `auto` | `auto` \| `supervised` \| `manual`. |
| `--model-override <role=profile>` | — | Repeatable. |
| `--approve <tool>` | — | Repeatable. Grants a tool the Blueprint put behind approval. |

`loom run` waits for the run and prints the manifest; `loom serve` does not — it answers with an id and proceeds.

Not built: `--json`, `--dry-run`, `--effort`, `--agents`, `--base`, and `loom worktrees`. Each is backlog.

---

## 2. HTTP API

All JSON. Started with `loom serve`; the API is the operator's interface to a running engine, so it is a first-class contract, not a UI detail.

Every endpoint is a pure function of the request and the run service (`source/server/routes.ts`), so the whole surface is testable without a socket. The transport (`source/server/server.ts`) does the I/O.

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | Liveness, and which run is going. |
| `/api/runs` | POST | Start a run (`{ task, autonomy? }`). Answers `202` with the id **without waiting for the run**. |
| `/api/runs` | GET | List runs, newest first. |
| `/api/runs/:id` | GET | The manifest, plus whether the run is still going and whether it is held. |
| `/api/runs/:id/events` | GET | Paged event stream (`offset`, `limit`). |
| `/api/runs/:id/diff` | GET | Combined or per-agent diff (`?agent=`). |
| `/api/runs/:id/trace` | GET | Spans with per-span cost. |
| `/api/runs/:id/merge` | POST | Merge a branch (`{ agentId }`). |
| `/api/runs/:id/undo` | POST | Return the base to the commit the run started from. |
| `/api/runs/:id/steer` | POST | Inject an operator message at the next turn boundary. |
| `/api/runs/:id/pause` | POST | Hold the run at its next turn boundary. |
| `/api/runs/:id/resume` | POST | Release the hold. |

**One run at a time per project.** The workspace is one git repository; two runs would race on the same worktrees and the same index. The service owns that invariant and answers `409` for a second submission, so no transport has to.

**Authorization.** A bearer token on every `/api/` call, from `LOOM_TOKEN`. Without it the check is disabled — safe only on a loopback bind, and a deliberate choice rather than a default. Static assets are served without a token: the page is not secret, and a browser cannot present a credential before it has loaded one. A `401` says whether the credential was missing or wrong.

**Errors are values.** A refusal is a status and a `{ error }` body, never a thrown exception crossing the wire. `409` means the operation was understood and refused; `400` means the request was malformed; `404` an unknown run or route; `405` a write to a read route.

Not yet built: `/cancel`, `GET|PUT /api/blueprint`, `/api/config`, and the WebSocket stream. Each is backlog.

---

## 3. Web UI

One page, served from `source/server/static/`, with **no build step** — `index.html`, `app.js`, `styles.css`, and nothing to compile. It polls, because the API is already the authority on what happened and a second channel that pushes would be a second version of the truth.

`bun source/demo.ts` is the way to see it working without a model endpoint: it builds a throwaway repository, starts a stub model, records two runs, and serves the UI. The default port is a suggestion — if it is taken the demo binds a free one and prints where it landed; a port asked for with `--port` is never overridden, and a taken one is reported as a sentence rather than a stack trace.

Three regions:

- **Runs** — list with status, task, and cost, newest first.
- **Run view** — manifest summary, the agent rows with per-agent cost and tokens, the live event feed, the **trace** (agent → turn → tool spans, indented by nesting, each with its latency and cost), and the **diff review** panel (what the run actually changed).
- **Controls** — start a run, steer, pause, resume, undo, and diff/merge per agent. A control is disabled unless the run is the one in progress, so the UI cannot offer an action the API would refuse.

Agent-authored text is set as a text node, never as HTML.

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

- [x] A run is startable, watchable, reviewable (diff), and revertible from the UI. — driven end to end in a browser: started, steered, held, resumed, diffed, merged, undone.
- [x] Traces expose agent → turn → tool spans with per-span cost. — `/api/runs/:id/trace`, rendered in the run view.
- [x] The UI has no JavaScript build step. — three static files, served as-is.
- [x] An operator's message reaches the **model**, not merely the log. — the smoke asserts the stub endpoint received `[Operator notice] …` in a later request.
- [x] A held run really stops: no further turn is recorded while it is paused.
- [ ] Run search and filter — backlog.
- [ ] Live push over a WebSocket — backlog; polling is the only channel today.

## 6. The trace

Derived from the event log rather than emitted live, because the log is already the authority on what happened; a second in-memory trace would be a second version of the truth and the two would drift.

A span has an id, a parent, a name, a kind, a start and (usually) an end, attributes, and a cost — the OpenTelemetry shape. Exporting through the OTel SDK is a dependency this project does not carry; the data is what matters, and the endpoint serves it as JSON.

Per-turn cost requires a per-turn record, which is why the loop emits `model_call` with the turn's own usage. Before that, the log carried agent totals only, and no turn could be priced.
