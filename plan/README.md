# Plan

The design and work plan for **Loom** — a git-native, concurrent, provider-agnostic multi-agent engine with an evaluation-driven tuner.

**Status: M0–M8 implemented.** The engine, the bench, the tuner, and the HTTP/UI surface are built and tested; the documents here are the design they were built against. Where a document and the code disagree, the code wins and the document is fixed in the same change.

## The four decisions

| Decision | Choice |
|---|---|
| **Wedge** | Git-native concurrent core — worktree-per-agent isolation + parallel scheduler + commit/diff/rollback |
| **Stack** | TypeScript + Bun |
| **Models** | **One model, guided by the Tuner.** Routing exists as a mechanism; the model is pinned, and the search tunes the conditions around it. |
| **Autonomy** | `auto` — the operator is not the gate; the tests are, backed by one-command undo |

## Vocabulary

The component names, chosen deliberately — and **not** the reference project's `Guild` / `Executor` / `Foundry`.

| Name | What it is | Was |
|---|---|---|
| **Blueprint** | the config file — roles, tools, routing, budgets, permissions | Org |
| **Engine** | the program that runs a Blueprint | Runtime |
| **Tuner** | the offline loop that improves a Blueprint | Optimizer |
| **Bench** | the scoreboard — benchmarks, scoring, the held-out split | Harness |

A **benchmark** is one task; the **Bench** is the thing that runs them all.

## The thesis

> Concurrency and isolation are the hard half. Measurement is the other hard half. The tuner is worthless without both.

The concept — orchestrating a small model into a network of specialized roles — is not original, and the field is crowded (AutoGen, LangGraph, CrewAI, DSPy, SWE-agent, OpenHands). The reference implementation (`Zoltu/orchestration-builder`) has the concept and a strong design, but explicitly **refused** parallelism, worktrees, and per-task isolation, and **deferred** the evaluation bench and the tuner. Loom is built on exactly those deferrals.

## Documents

| # | Document | What it covers | Review |
|---|---|---|---|
| 1 | [architecture.md](architecture.md) | The layers, the data flow, and how this differs from prior art | **in review** |
| 2 | [isolation.md](isolation.md) | **The wedge.** Worktree-per-agent, the concurrent scheduler, fan-out, best-of-N, merge | pending |
| 3 | [blueprint-format.md](blueprint-format.md) | The Blueprint config spec — roles, tools, routing, budgets, permissions | pending |
| 4 | [model-routing.md](model-routing.md) | Provider interface, routing profiles, cost accounting, budgets | pending |
| 5 | [bench.md](bench.md) | The bench — benchmarks, isolated runs, scoring, the held-out split | pending |
| 6 | [tuner.md](tuner.md) | The closed loop — hypothesize, branch, evaluate, merge, promote | pending |
| 7 | [security.md](security.md) | Threat model, permission modes, sandbox, egress, secrets, audit | pending |
| 8 | [surfaces.md](surfaces.md) | CLI, HTTP API, web UI, data layout | pending |
| — | [roadmap.md](roadmap.md) | Milestones M0–M8, acceptance criteria, tracked debt, backlog, open decisions | synthesis; re-read last |

## Review walkthrough

One document at a time, in the order above, before any code is written. A document is signed off when its open questions are resolved and its claims are agreed. The **Review** column tracks position; decisions are recorded in the document that owns them, and a decision that moves a milestone is reflected in [roadmap.md](roadmap.md).

## What we build first

The first four milestones are the product; everything after is leverage.

1. **M0 Foundations** — scaffold, Blueprint loader, model provider + fake, CLI skeleton.
2. **M1 Isolation** — the worktree primitive. Nothing else is safe without it.
3. **M2 Concurrency** — N agents in parallel, each in its own worktree.
4. **M3 Git-native lifecycle** — every run a branch, a diff, and a rollback.

Only after M3 does M4 (routing/cost) and M5 (evaluation) make sense — and only after M5 is M6 (the tuner) anything more than a demo.

## Conventions

Each document states its own status. When a document and the code disagree, the code wins and the document is fixed in the same change. A document describing unshipped behavior is a bug.
