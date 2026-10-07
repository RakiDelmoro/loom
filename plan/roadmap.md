# Roadmap

The work plan for Loom. Design lives in the sibling documents; this one plans the *work*.

Milestones are sequential: the isolation primitive must exist before the engine can be concurrent; the engine before the bench; the bench before the tuner. Within a milestone, `bun run typecheck` and `bun test` are green at every close.

---

## M0 — Foundations

**Goal.** A typed, testable skeleton: load and validate a Blueprint, resolve a role to a model profile, and call a provider — with a fake provider so everything is testable in memory.

**Deliverables.**

1. **Project scaffold.** `package.json`, `tsconfig.json`, `bunfig.toml`, directory layout, `AGENTS.md` (engineering rules), `CONTRIBUTING.md`.
2. **Blueprint layer.** Types for roles/tools/routing/budgets/permissions; strict validators (unknown keys rejected at every level); a loader leaf. See [blueprint-format.md](blueprint-format.md).
3. **Model layer.** A `Provider` interface with tool-calling; an `openai-compatible` client (covers OpenAI, llama.cpp, Ollama, vLLM, OpenRouter); a `fake` provider for tests; a pure router mapping role → profile. See [model-routing.md](model-routing.md).
4. **CLI skeleton.** `loom blueprint validate <file>` and `loom --version`.

**Acceptance criteria.**

- [x] `bun test` green; `bun run typecheck` clean.
- [x] `loom blueprint validate` accepts the example Blueprint and rejects a malformed one with a path-based error.
- [x] The router maps every role in the example Blueprint to a profile, with a unit test.
- [x] The `openai-compatible` client is tested against a fake `fetch` (no network).

---

## M1 — Isolation primitive (worktree per agent)

**Goal.** Create and destroy isolated git worktrees safely. This is the foundation the whole thesis rests on. See [isolation.md](isolation.md).

**Deliverables.**

1. **Git leaf.** A factory over `git` subprocess calls (worktree add/remove/list, commit, branch, diff, rev-parse).
2. **Worktree orchestration.** `create(runId, agentId, baseSha)`, `commit`, `remove`, `removeRun`, `resolveBaseSha`, `list`; naming derived from the run and agent ids; `.loom/` git-excluded, following worktree `gitdir` links.
3. **Idempotent cleanup** — `remove` and `removeRun` are safe to run twice and leave no registered worktrees or stray directories. (Wiring cleanup to *every run exit path* needs a run loop, so that lands in M2/M3.)
4. **Two test lanes** — the fast suite proves the manager's logic against a fake git; an opt-in integration lane (`bun run test:git`) proves isolation against real git, which no fake can.

**Acceptance criteria.**

- [x] An integration test creates 3 worktrees from a temp repo, writes distinct files, and commits to 3 branches.
- [x] Isolation is proven: a file written in worktree A is absent in worktree B and in the base.
- [x] Cleanup leaves no registered worktrees and no stray directories.
- [x] `.loom/` never appears in `git status`.

---

## M2 — Concurrent agent engine

**Goal.** N agents run in parallel, each in its own worktree, each driven by a model tool-loop.

**Deliverables.**

1. **Tool registry + built-ins.** `agent`, `finish`, `read_file`, `write_file`, `list_dir`, `glob`, `search`, `run_shell`, `git_status`, `git_diff`, `git_log`. Path canonicalization confined to the worktree.
2. **Agent loop.** Prompt assembly, model call, tool-call parsing, dispatch, result append, `finish` handling, implicit-finish on no tool calls.
3. **Bounded pool scheduler.** `maxConcurrentAgents` bounds in-flight *model calls* — bounding the agent instead would let a tree deadlock against its own limit, since a parent waiting on children would hold a slot. Fan-out via `agent` with a per-role ceiling; stable spawn-order results; a `maxAgentDepth` guard. Worktrees are single-flight by construction: one agent owns each.

**Acceptance criteria.**

- [x] With a scripted fake provider, 4 agents run concurrently — asserted by overlapping start/end timestamps, not by wall-clock timing.
- [x] Each agent produces a distinct commit on its own branch.
- [x] A tool that throws becomes a structured error result; the run does not crash.
- [x] Exceeding `maxAgentDepth` is refused with a typed error and a logged event.
- [x] Result ordering is identical across runs regardless of completion order.

---

## M3 — Git-native run lifecycle

**Goal.** Every run is reviewable and reversible.

**Deliverables.**

1. **Run manifest** (`run.json`): status, agents, branches, commit shas, token usage, timings, and the base ref and commit. Rewritten as each agent finishes, so a run killed mid-flight still leaves a manifest naming every agent that ran.
2. **Event log** (`events.jsonl`): append-only `run_started`, `agent_start`, `tool_call`, `tool_result`, `commit`, `agent_finish`, `error`, `run_finished`. Never rewritten, so it stays truthful when a run is killed.
3. **CLI:** `loom run`, `loom runs`, `loom status`, `loom diff [--agent]`, `loom merge --agent`, `loom undo`, `loom clean [--branches]`.
4. **Autonomy level** — `auto` | `supervised` | `manual`. `auto` merges the run's branches when it finishes successfully; `supervised` and `manual` leave merging to the operator. See [isolation.md](isolation.md) "Who reviews, and who merges".

**Acceptance criteria.**

- [x] An end-to-end run on a real repo yields branches whose `git diff` matches the manifest.
- [x] `loom diff` shows the union of all agents; `--agent` shows one.
- [x] `loom merge --agent` applies exactly one branch to the base.
- [x] `loom clean` restores the repo to a pristine worktree state.
- [x] `loom undo <runId>` restores the base branch to the run's recorded starting commit.
- [x] A run killed mid-flight leaves a truthful manifest and a worktree that `loom clean` removes — never a leak. (Resuming an interrupted run is not implemented; it is abandoned cleanly.)

---

## M4 — Hybrid routing and spend accounting

**Goal.** Cheap roles on local models, hard roles on cloud, with dollar accounting that is **measured and reported but never enforced**. See [model-routing.md](model-routing.md).

**Deliverables.**

1. **Provider registry** — named providers with endpoints and credentials from the deployment file/environment, never the Blueprint.
2. **Cost accounting** — per-model prices; per-call, per-agent, and per-run token and dollar totals, with a per-model breakdown, recorded in the manifest.
3. **Spend visibility, never enforcement** — an optional `alerts` threshold emits an event and nothing else. No run is stopped over money; `maxAgentDepth`, the per-role turn limit, the tool timeout, and the deployment container are what bound a runaway run.
4. **Per-run overrides** — `--model-override role=profile`.

**Acceptance criteria.**

- [x] Cost math is unit-tested (including cached/uncached input pricing).
- [x] A run that crosses its alert threshold emits an event and **continues to completion**.
- [x] The manifest records which model served each role, and what each cost.
- [x] Credentials never appear in the Blueprint, the manifest, or the log.

---

## M5 — Bench (evaluation)

**Goal.** A number worth optimizing against. **This milestone is the moat.** See [bench.md](bench.md).

**Deliverables.**

1. **Benchmark format** — a self-contained task: an initial `workspace/`, a plain-language task, and a machine-checkable definition of done. The spec is never copied into the workspace.
2. **Runner** — each benchmark in its own throwaway repository, `--repetitions` repetitions, deterministic validation first and an optional LLM judge above it. Teardown on every exit path.
3. **Scoring** — the mean score with a 95% Wilson interval; cost and latency reported alongside rather than folded into it.
4. **Regression tracking** — results persisted to `<repo>/.loom/bench/<timestamp>.json`; a held-out split the tuner can never run.

**Acceptance criteria.**

- [x] A suite of ≥5 real tasks runs end-to-end and emits a reproducible score.
- [x] A deliberately degraded Blueprint scores measurably lower, with non-overlapping intervals.
- [x] Scores include confidence bounds and are stable across repetitions.
- [x] The held-out split is enforced structurally: `suite.json` must partition the benchmarks, and an optimization run never executes the held-out half.

---

## M6 — Tuner (the loop)

**Goal.** The idea made true: a closed loop that improves the Blueprint. See [tuner.md](tuner.md).

**Deliverables.**

1. **The loop** — observe → hypothesize → branch → evaluate → score → merge → report → promote → repeat, under guardrails.
2. **Guardrails** — cycle budget, the Tuner's own cost ceiling, plateau detection, and a promotion contract checked before evaluation.
3. **Held-out gate** — the merged candidate is re-evaluated on the held-out split, and promotion requires improvement there.

**Acceptance criteria.**

- [x] A full cycle runs end-to-end and produces a report.
- [x] A candidate improving the baseline by the configured margin is promoted; a regressing candidate never is.
- [x] A hypothesis producing an invalid Blueprint is dropped with the reason recorded.
- [x] Held-out gating blocks a candidate that overfits the optimization split.

---

## M7 — Safety and control

**Goal.** Deployable trust. See [security.md](security.md).

**Deliverables.** Permission modes; approval gates for `run_shell` and commits; sandboxed command execution; egress allowlist; secret redaction; audit log; plan-approval and live steering.

**Acceptance criteria.**

- [ ] `read-only` mode blocks every mutating tool with a structured denial; the run continues.
- [ ] A denied command never reaches the shell (asserted, not assumed).
- [ ] No credential appears in any transcript or log (leak test).
- [ ] An operator can pause a run, edit the plan, and resume.

---

## M8 — Surfaces

**Goal.** Human control and visibility. See [surfaces.md](surfaces.md).

**Deliverables.** HTTP API + web UI (run list, live run view, **diff review**, cost/latency/trace dashboard); run search/filter; authentication; OpenTelemetry tracing.

**Acceptance criteria.**

- [ ] A run is startable, watchable, reviewable (diff), and revertible from the UI.
- [ ] Traces expose agent → turn → tool spans with per-span cost.
- [ ] The UI works without a JavaScript build step, or with exactly one documented build step.

---

## Tracked technical debt

No debt is currently tracked.

When you add a row, also update the target milestone's deliverables to describe the removal work. When you remove the debt, delete the row.

---

## Backlog

Unbuilt features. None is scheduled; each needs a fresh scoping before work begins.

- **MCP client.** Let external MCP servers contribute tools without forking the engine. Highest-value ecosystem item.
- **Project memory and retrieval.** Per-repo conventions, architecture map, and failure post-mortems, retrieved into context. Runs are amnesiac today.
- **Best-of-N and speculative execution.** First-class strategies on top of the pool.
- **Model-assisted merge conflict resolution.** Builds on M3's explicit merge.
- **Blueprint authoring surface.** View/diff/A-B a Blueprint; a prompt registry and versioning.
- **Dollar dashboards and pricing sources.**
- **Multi-user and hosted control plane.** Auth exists in M8; tenancy does not.
- **Mobile.** Desktop-first by design.
- **Response caching / prefix reuse.**

---

## Open decisions (resolve before or during M0)

1. **Name.** "Loom" is a placeholder; renaming is cheap until paths freeze in M0.
2. **Sandbox boundary.** bubblewrap vs gVisor vs container for command execution (M7). Affects portability and the bench's per-benchmark isolation (M5).
3. **Bench execution.** Worktree only, or container per benchmark? Container isolation is stronger but heavier.
4. **Tuner home.** In-repo module, or a separate program consuming the engine's HTTP API only?
5. **Auth model.** Local single-user with a token, or full accounts (M8)?
