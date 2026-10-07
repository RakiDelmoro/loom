# Loom

A git-native, concurrent, provider-agnostic multi-agent engine with an
evaluation-driven tuner.

Loom runs a network of specialized roles against a project. Every worker gets
its own git worktree, so they run in parallel without colliding, and every run
is a branch, a diff, and a one-command rollback. The engine then measures its
own behavior against a benchmark suite, and the Tuner uses that number to
improve the configuration the engine runs on.

> Concurrency and isolation are the hard half. Measurement is the other hard
> half. The tuner is worthless without both.

## The four decisions

| Decision | Choice |
|---|---|
| **Wedge** | Git-native concurrent core — worktree-per-agent isolation, a parallel scheduler, commit/diff/rollback |
| **Stack** | TypeScript + Bun |
| **Models** | **One model, guided by the Tuner.** Routing exists as a mechanism; the model is pinned, and the search tunes the conditions around it. |
| **Autonomy** | `auto` — the operator is not the gate, the tests are, backed by one-command undo |

## Vocabulary

The component names are deliberate.

| Name | What it is |
|---|---|
| **Blueprint** | The configuration — roles, tools, routing, budgets, permissions |
| **Engine** | The program that runs a Blueprint |
| **Bench** | The scoreboard — benchmarks, scoring, the held-out split |
| **Tuner** | The offline loop that improves a Blueprint |

A **benchmark** is one task; the **Bench** is the thing that runs them all.

## Run it

```bash
bun install
bun run loom --help
bun run loom blueprint validate loom.json
bun run loom bench --suite benchmarks --split optimization --repetitions 2
bun run loom serve --repo .          # the HTTP API and the browser UI
```

`bun test` is the fast suite — in-memory, milliseconds. `bun run test:git` is
the opt-in lane that runs real git against a temporary repository.

There are no runtime dependencies; see "No dependencies" in
[`AGENTS.md`](AGENTS.md) for why that is not an accident.

## Where the design lives

[`plan/`](plan/) holds the design and the work plan, and its status line is the
honest one: **M0–M8 implemented** — the engine, the Bench, the Tuner, and the
HTTP/UI surface are built and tested.

The rule for every document there: where a document and the code disagree, the
code wins, and the document is fixed in the same change. A document describing
unshipped behavior is a bug.

Read [`AGENTS.md`](AGENTS.md) before changing anything, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) for setup and conventions.

## On prior art

The concept — orchestrating a small model into a network of specialized roles —
is not original, and the field is crowded. The reference implementation
([`Zoltu/orchestration-builder`](https://github.com/Zoltu/orchestration-builder))
has the concept and a strong design, but explicitly *refused* parallelism,
worktrees, and per-task isolation, and *deferred* the evaluation bench and the
tuner. **Loom is built on exactly those deferrals**, and on the conviction that
the scoreboard has to come before the loop that optimizes it.
