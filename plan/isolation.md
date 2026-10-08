# Isolation and Concurrency — the wedge

This is the document the whole project rests on. Everything else is leverage; this is the product.

**One git worktree per agent.** That single primitive buys three things at once:

1. **Safe parallelism** — agents cannot corrupt each other's files.
2. **Reviewable output** — every agent's work is a diff on a branch.
3. **Reversibility** — a bad run is one `git worktree remove` and one `git branch -D` away.

---

## 1. Why worktrees, not containers, not copying

| Option | Cost | Review surface | Toolchain | Verdict |
|---|---|---|---|---|
| Shared tree + locks | cheap | none | native | no parallelism; the reference implementation's compromise |
| Copy the tree | O(repo) per agent | none | native | slow, no git history link |
| **git worktree** | ~ms, hardlinked objects | native `git diff` | native | **chosen** |
| Container per agent | seconds, daemon | needs plumbing | image must provision it | a *sandbox* boundary, not an *isolation* boundary |

Worktrees are an isolation boundary. Containers are a **security** boundary (see [security.md](security.md)). They are orthogonal and composable: worktree *inside* a container is the strongest configuration, but worktrees alone already make concurrency correct.

---

## 2. Layout and naming

```
<repo>/                                   # the user's repository (base ref)
├── .loom/                                # git-excluded bookkeeping
│   ├── runs/<runId>/
│   │   ├── run.json
│   │   ├── events.jsonl
│   │   └── agents/<agentId>/
│   │       ├── transcript.jsonl
│   │       └── result.json
│   └── worktrees/<runId>/<agentId>/      # the git worktree
└── (project files)
```

- **Branch:** `loom/<runId>/<agentId>`
- **Worktree path:** `<repo>/.loom/worktrees/<runId>/<agentId>/`
- **Run id:** `<UTC-compact>-<short-random>`, e.g. `20261007T142233Z-a1b2c3`
- **Agent id:** `<role>-<depth>-<counter>`, e.g. `coder-1-4` (matches the reference implementation's instance-id convention, which is good)

`.loom/` is appended to the repository's git exclude file — `.git/info/exclude`, following a worktree `gitdir` link if the base repo is itself a worktree — so bookkeeping never appears in `git status` and is never accidentally committed.

---

## 3. Lifecycle

```
create(runId, agentId, baseRef) → { path, branch }
        │  git worktree add -b loom/<runId>/<agentId> <path> <baseRef>
        ▼
   agent works (its cwd is `path`; every path tool is confined to it)
        ▼
commit(agentId, message) → { sha }        # only if the agent changed anything
        ▼
remove(runId, agentId)                    # git worktree remove --force
        ▼
removeRun(runId, { branches: boolean })   # prune dirs; optionally delete branches
```

**Base ref pinning.** The run resolves `baseRef` (default: `HEAD` of the base repo) to a **commit sha** at start and records it in the manifest. Every worktree branches from that sha, so agents are mutually independent even if the base repo moves during the run.

**Commit-on-finish.** An agent's work is committed when it finishes with a clean status. If `git status --porcelain` is empty, no commit is made and the manifest records `sha: null`. Commit message: the agent's `finish` summary, first line, plus a trailer `Loom-Agent: <agentId>` and `Loom-Run: <runId>`.

**Cleanup on every exit path.** Success, error, timeout, and signal. `git worktree prune` runs after removal. A crash leaves the run directory intact so `loom clean <runId>` can finish the job; a leaked worktree is a bug, and M1's acceptance criteria test for it.

---

## 4. Edge cases (must be handled in M1)

| Case | Behavior |
|---|---|
| Base repo has uncommitted changes | Allowed. Agents branch from the pinned sha, so they never see uncommitted base state. Record `baseDirty: true` in the manifest. |
| Base repo is a bare repo | Rejected with a typed error; worktrees need a work tree. |
| Base repo is itself a worktree | Supported; the exclude file is written to the linked `gitdir`. |
| Submodules | Not initialized in agent worktrees by default (documented; backlog). |
| Branch name already exists | Run ids are unique; a collision is a typed error, never a silent reuse. |
| Detached HEAD base | Resolved to a sha; fine. |
| Two agents, same worktree | Impossible by construction — the scheduler assigns one owner per worktree and asserts it. |
| Worktree removal while a subprocess runs in it | Kill the subprocess first; the pool owns the child process and drains it before removal. |
| Disk full / worktree add fails | Typed error; the run fails cleanly with no half-created worktree. |

---

## 5. The concurrent scheduler

A run is a DAG of agents executed by a **bounded pool**.

```
scheduler
  ├─ maxConcurrentAgents (run-wide ceiling)
  ├─ per-role parallel.maxChildren (fan-out ceiling for one parent)
  ├─ maxAgentDepth (recursion ceiling)
  └─ budgets.loopCheck (a handler role ends a role that repeats itself)
```

**Fan-out.** When a role calls `agent`, it may pass several tasks; up to `parallel.maxChildren` start immediately, the rest queue. The call returns when all have joined.

**Join semantics.** A parent resumes only when every child it spawned has reached a terminal state. Child results are collected **in submission order**, not completion order — so the parent's context is deterministic regardless of which child finished first.

**Scheduling order.** The pool is a queue with a global concurrency ceiling. A child that cannot start (ceiling reached) waits; it does not block its siblings' queue slots unfairly — the pool is fair by submission order.

**Cancellation.** A parent that finishes (or errors) cancels its unfinished children: signal the pool, drain their subprocesses, remove their worktrees, record `cancelled` in the manifest. A cancelled child's partial work is **not** committed.

**Best-of-N.** A role may request `n` attempts of the same task; the pool creates `n` worktrees, runs them, and a deterministic scorer — the same validation a benchmark uses — selects one. The losers are recorded and cleaned. This is a first-class strategy, not a hack — and it is only possible because worktrees are cheap.

**Determinism.** Given the same Blueprint, base ref, and a scripted provider, the manifest is identical except for timestamps, shas, and ids. Tests assert this.

---

## 6. Merge model

Agents branch from the same pinned sha, so their results are independent until merged. Integration is **explicit**:

- `loom merge <runId> --agent <id>` — apply one branch to the base working tree (`git merge --no-commit`, or `git cherry-pick` of the agent's commits).
- Conflicts are surfaced with the file list and left unresolved. Silent auto-resolution is forbidden; model-assisted resolution is a backlog item.
- An Blueprint may declare an **integration role** that runs after the fan-out and is responsible for merging accepted branches and resolving conflicts — but it merges through the same explicit primitives, and its merges are commits like any other.

### Work flows up the delegation tree

A child's committed branch is merged into **its caller's workspace** the moment the child returns, before the caller sees the result card. The card records whether that worked, so a caller can tell a sub-task it can build on from one whose changes did not land.

Three things follow from it, and they are the reason it is not optional:

1. **A caller can build on its children.** An orchestrator that cannot see what its coder produced is not orchestrating; it is guessing.
2. **A `shared` role can do its job.** `shared` means *the caller's tree* — not the base repository. A reviewer that shares the orchestrator's workspace sees exactly what the orchestrator sees, which is what "review" means.
3. **The base stays untouched during the run** whenever the entry role is `worktree`-isolated, because the chain of integrations terminates at the entry role's tree. Landing work in the base remains the end-of-run merge's job, and only `auto` autonomy does it.

Integrations into one workspace are serialized: siblings finish concurrently, and two merges into one working tree would race. A merge that would conflict is refused and aborted rather than left half-applied — the caller is working in that tree.

**This was not true until a real model found it.** `shared` originally meant the base repository, and child branches merged only at the end of the run. So a `reviewer` — `shared`, and therefore sitting in the base — could never see a coder's work, reported "the change did not land", and the orchestrator retried until a coder wrote into the base through a shell to make the review pass. The record shows four coders on a one-line bugfix, three failed reviews, and a benchmark that scored the escape as a success.

### What actually lands

Two rules decide which of a run's branches its work consists of. Both were missing, and both cost real benchmark runs.

**Only a successful role's work counts.** An attempt that ended in `error` keeps its commits on its own branch, for inspection, and does not travel. Reproduced: three coders hit their turn limit, ended `error`, and had their commits merged into the base anyway — the merge filtered on "has a commit" and never looked at status.

**A retry supersedes the attempt it replaced.** The caller asked a second time because the first answer was not good enough, so the newer attempt *replaces* it:

- at the end of the run, only the **last successful attempt of each request** is merged;
- mid-run, when a second attempt at the same request reaches the caller's tree, the integration resolves conflicts in the newer attempt's favour instead of refusing.

Merging both was self-defeating: each attempt was written against the same base, so two attempts at the same files conflict arithmetically — and the more persistent the loop, the less able the run was to deliver anything at all. Retrying is the intended recovery mechanism; it cannot also be what breaks the run.

A **request** is a role, a task, and the agent that asked — so the same role asked for two *different* things is two pieces of work and both land, while the same thing asked twice is one. That is why the delegated task is now recorded on each agent: without it, "the orchestrator asked again" cannot be told from "the orchestrator asked two agents for different things" — the difference between a retry and parallel work, and the signal any progress check would need.

The limit is honest: recognition is textual, so a retry that *rewords* its task reads as new work. A model that rewords has changed its approach, which is arguably not the same attempt.

### Who reviews, and who merges
A branch per agent is a **safety net and a merge point**, not an obligation on the operator. The default path is autonomous:

1. **Reviewer agents** inspect each branch — read-only tools, ideally a different model from the writer, so blind spots are not correlated.
2. An **integration role** merges accepted branches and resolves conflicts.
3. The operator receives a **run summary** (what changed, cost, which checks passed) and can drill into any branch's diff on demand.

The operator is the reviewer only when the run's **autonomy level** says so:

| Level | Reviews | Merges | The operator |
|---|---|---|---|
| `auto` | reviewer agents | integration role | reads a summary; can undo anything |
| `supervised` | reviewer agents | **the operator approves** | approves or denies the merge; sees the diff first |
| `manual` | the operator | the operator | reviews every branch |

**`auto` is the default.** The point of the project is to run without the operator in the loop, so the operator is not the gate — the tests are. `supervised` and `manual` stay available per run for a repository where the operator wants to approve merges; the level is a Blueprint/deployment setting, never hard-coded.

**What makes `auto` safe is reversibility, not review.** A run records the base commit it started from, and `loom undo <runId>` restores the base branch to that commit in one command. Autonomy without an undo path would be reckless; with it, a bad merge is a mistake you fix in seconds rather than a disaster.

Because `auto` removes the human gate, two things carry the weight instead: the **bench** ([bench.md](bench.md)) is the only pre-merge gate, and the **sandbox** ([security.md](security.md)) is the only containment. Both are therefore non-negotiable, not optional hardening.

**Branches exist for four reasons, and only one is human review:** isolation (parallel work without collisions), undo (a bad run is always reversible), audit (the record of what happened), and a merge point (which an agent can operate as well as a person).

---

## 7. What this enables that the reference implementation cannot do

- Three reviewers in parallel instead of serially.
- Best-of-N on a hard step, cheaply.
- Independent verification: one agent writes, another independently checks, in a separate tree.
- Speculative exploration of two designs, then pick one.
- A run that leaves a reviewable branch per agent, so a human reviews diffs, not transcripts.
- A benchmark bench that runs each task in a clean tree — which is what makes [bench.md](bench.md) possible at all.

---

## 8. Acceptance tests (M1/M2)

- Create 3 worktrees; write `a.txt` in A only; assert `a.txt` exists in A, not in B, not in base.
- Commit in each; assert three distinct shas on three distinct branches.
- Kill the process mid-run; assert `loom clean` removes every registered worktree and the repo's `git status` is clean.
- Run 4 agents with a scripted provider; assert overlapping `[startedAt, finishedAt)` intervals (concurrency proven by overlap, never by wall-clock duration).
- Assert `.loom/` is absent from `git status --porcelain` before and after a run.
