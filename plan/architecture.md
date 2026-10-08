# Architecture

Loom is a **git-native, concurrent, provider-agnostic multi-agent engine with an evaluation-driven tuner**. It runs a network of specialized roles against a project, isolates each worker in its own git worktree so they can run in parallel safely, routes each role to the model that fits it, and measures its own behavior so it can be improved.

Sibling documents: [isolation.md](isolation.md) (the wedge), [blueprint-format.md](blueprint-format.md) (the config), [bench.md](bench.md) and [tuner.md](tuner.md) (the measurement and the loop).

---

## 1. Positioning

The concept is not original. The field:

| Pillar | Prior art |
|---|---|
| Multi-agent role systems | AutoGen, CrewAI, LangGraph, MetaGPT, CAMEL, OpenAI Agents SDK |
| Autonomous coding agent | SWE-agent, OpenHands, Aider, Devin, Claude Code subagents, Codex |
| Behavior-as-data (config-defined agents) | partial: LangGraph graphs, CrewAI YAML — nearly always code-defined agents |
| Meta-optimization of agent config | DSPy (MIPRO/OPRO), TextGrad, ADAS, EvoPrompt, PromptBreeder |
| Benchmarks | SWE-bench / Verified, Terminal-Bench, GAIA |
| Tool protocol | MCP (Anthropic), A2A (Google) |

What is rare is the **combination**: a system whose entire behavior is data, measured by its own bench, optimized by a closed loop.

The reference implementation (`Zoltu/orchestration-builder`) has the concept and a strong design. It **shipped a bench** — nine benchmarks and a validation runner, with the same `pass` / `fail` / `error` trichotomy — but it **scored pass/fail only**: no interval, no held-out split, no cost accounting. It **refused** parallelism, worktrees, and per-task isolation, and it left its optimizer, the Foundry, as a design document rather than a program. Loom is built on those gaps. They are the moat: not *a* bench — it had one — but a bench that **discriminates**.

**Loom's thesis, one line:** *concurrency and isolation are the hard half, measurement is the other hard half, and the tuner is worthless without both.*

---

## 2. Layers

Three layers, cleanly separated. Each layer only talks to the one below it.

```
Tuner      (offline)  propose → branch blueprint → evaluate → score → merge → promote
    │ reads/writes
    ▼
Bench      (offline)  benchmark suite → isolated runs → validated scores + statistics
    │ drives
    ▼
Engine     (online)   concurrent agent scheduler · agent loop · tool dispatch
    │ loads
    ▼
Blueprint  (data)     roles · tools · routing · permissions · budgets
    │ operates on
    ▼
Workspace  (git)      one worktree per agent, committed to a branch
```

- **Blueprint** — the entire behavior of the system as data. Roles, their prompts, their tool grants, their model routing, the run's permission mode and budgets. This is the artifact the Tuner rewrites. There is **no workflow graph**; workflows emerge from roles calling `agent`.
- **Engine** — domain-blind and minimal. It does not know what a "planner" is. It schedules agents, runs their tool loops, enforces budgets and permissions, and records what happened.
- **Bench** — turns a behavior into a number, honestly.
- **Tuner** — improves the number without overfitting.

---

## 3. Data flow: a single run

1. An operator submits a task against a repository, with a Blueprint and a base ref.
2. The engine pins the base ref, creates a run directory, and starts the entry role.
3. The entry role calls `agent`; the scheduler fans out. Each child gets its **own worktree** on its own branch, and its **own model profile**.
4. Children run concurrently (bounded by `maxConcurrentAgents`), each driving a tool loop against its worktree.
5. A child that finishes has its work committed to its branch; the commit sha lands in the manifest.
6. The entry role joins results and calls `finish`.
7. The run is reported: status, per-agent branches and shas, diffs, cost, timings.

Nothing is inferred from prose. The manifest and the event log are the record.

---

## 4. Execution model

- **Concurrent DAG, not a depth-first tree.** Fan-out/fan-in with a bounded pool; stable result ordering.
- **Single-flight per worktree.** A worktree has exactly one owner at a time, enforced structurally. This is what makes concurrency safe — the reference implementation is sequential *because* it shares one working tree.
- **Bounded depth.** `maxAgentDepth` bounds recursion, and each role has a turn limit. Spend is measured but never enforced — see [model-routing.md](model-routing.md) "Spend visibility, not enforcement".
- **Determinism.** Given the same Blueprint, base ref, and scripted provider, a run produces the same manifest — except for timestamps and commit shas.
- **A role is told where it is working.** Every role's system prompt ends with its workspace root, that it is a git repository, that tool paths resolve against it and `run_shell` starts there, and that the engine commits — not the role. This is the one fact a model cannot infer, and without it a role recites a path from its training data: a run spent thirty of its fifty-eight shell commands discovering that `/testbed` and a Windows desktop path do not exist.

Details, edge cases, and the merge model: [isolation.md](isolation.md).

---

## 5. Configuration split

Behavior and deployment are separate files, deliberately:

- **Blueprint** (`loom.json`) — roles, prompts, tools, routing *profile names*, budgets, permissions. Pure behavior. This is what the Tuner rewrites.
- **Deployment** (`loom.deployment.json`) — provider endpoints, credentials, model ids, prices. Operator-set, environment-overridable, never touched by the Tuner.

The Tuner must never be able to leak a credential into the artifact it optimizes, and a run must be reproducible across deployments.

Details: [blueprint-format.md](blueprint-format.md), [model-routing.md](model-routing.md).

---

## 6. What is deliberately different from the reference implementation

| Dimension | Reference implementation | Loom |
|---|---|---|
| Execution | strictly sequential, depth-first | concurrent DAG, bounded pool |
| Isolation | one working tree, in-place mutation | one git worktree per agent |
| Git | none (only `.git/info/exclude`) | branch + commit + diff + merge + rollback per run |
| Models | one model for all roles, no override | per-role routing profiles, per-run overrides |
| Cost | token counts only | dollar accounting + hard budgets |
| Evaluation | 9 toy benchmarks, pass/fail | real tasks, variance, held-out split |
| Tuner | designed, unbuilt | built after the bench earns it |
| Safety | container-only, model trusted | permission modes, approval gates, sandbox, egress |

---

## 7. Failure philosophy

Every failure is a **typed result** the caller can act on, never an exception that unwinds the process: `timeout`, `unavailable`, `invalid_arguments`, `permission_denied`, `depth_exceeded`, `context_overflow`. Recovery policy for the *task* lives in the **Blueprint** (a recovery role, a delegation to retry), not in the engine — the engine stays domain-blind.

Two things the engine does own, because they are properties of a call rather than of the work:

- **A model call that produced no answer is retried**, bounded, with backoff — `unavailable`, `timeout`, `rate_limited`, and an empty completion. A local endpoint 500s on a tool call it cannot parse; a transport hiccup is not the task failing, and an autonomous system that dies on one is not autonomous. `invalid_response` is not retried: the provider answered with nonsense, and asking again does not fix that.
- **A run killed in flight is marked `interrupted`**, not left saying it is running. The manifest is written synchronously on the abort, before the process that asked for it can exit.

A run never dies because one agent failed. A service crash never loses committed work, because work is committed to git as it completes.

---

## 8. Non-goals

- Parallel writes to a single tree. (Isolation makes this unnecessary.)
- A hosted multi-tenant product before the engine is trustworthy.
- An tuner before a trustworthy number exists.
- Reimplementing a workflow DSL. Workflows are prompts and `agent` calls.
