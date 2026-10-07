# Tuner — the closed loop

The tuner is the reason the Blueprint is data. It reads a baseline Blueprint and recent failures, proposes concrete edits, tests them against the [bench](bench.md), and promotes what measurably improves.

**Prerequisite: [bench.md](bench.md).** A loop over a bad metric is a machine for producing confident nonsense. No tuner work starts until the bench can distinguish a better Blueprint from a luckier one.

---

## 1. The loop

```
observe → hypothesize → branch → evaluate → score → merge → report → promote → repeat
   ▲                                                                          │
   └──────────────────── guardrails (cycle / cost / plateau) ─────────────────┘
```

1. **Observe.** Read the baseline Blueprint, the bench's per-benchmark results, and the failure reasons clustered by benchmark and task type.
2. **Hypothesize.** A large model (a routed profile) proposes concrete, testable edits, each with a motivation, a mechanism, and a predicted impact.
3. **Branch.** Each hypothesis becomes a candidate Blueprint on disk, validated end-to-end with the Blueprint loader. An invalid candidate is **dropped with the reason recorded**, never crashed on.
4. **Evaluate.** Run each candidate against the **tuning split** of the suite via the bench.
5. **Score.** Compare each candidate to the baseline: improved, regressed, or noise.
6. **Merge.** Combine accepted candidates; a large model resolves conflicting edits, given the common ancestor and both diffs.
7. **Report.** A human-readable report: hypotheses, per-branch scores, accept/reject, the new-baseline diff.
8. **Promote.** If the merged candidate improves on the **held-out split**, it becomes the new baseline. Otherwise it is discarded and the plateau counter increments.
9. **Repeat** until a guardrail fires.

---

## 2. Hypotheses

A hypothesis is a concrete, testable change:

```jsonc
{
  "id": "h-014",
  "motivation": "The coder stops after the first failing test run instead of iterating.",
  "mechanism": "Add an explicit iterate-until-green instruction to prompts/coder.md and raise toolTimeoutSeconds.",
  "predictedImpact": "+10% pass rate on bugfix tasks",
  "changes": [
    { "path": "prompts/coder.md", "content": "<complete new file content>" },
    { "path": "blueprint.json", "content": "<complete new file content>" }
  ]
}
```

An edit is the **complete new file content**, never a patch: no patch engine, and every branch is auditable by diffing whole files. This is the reference implementation's choice and it is a good one — keep it.

**The tuning space:** prompt wording across all roles; routing profile assignments (which role uses which model — the highest-leverage, cheapest edit); the review-round caps; per-role tool lists; numeric budgets (`maxAgentDepth`, `maxConcurrentAgents`, `toolTimeoutSeconds`); and structural hypotheses (adding or removing a role, rewriting the entry prompt).

**Constraints the loop must respect** (or the tuner will cheat):

- It may **not** touch the deployment file, credentials, or prices.
- It may **not** weaken the permission mode or the tool grants that enforce safety.
- It may **not** edit the held-out split or the bench.
- It may **not** add tools that bypass path confinement or the sandbox.

These are enforced by validating every candidate against a **promotion contract** — a set of invariants the candidate must satisfy before it can even be evaluated. A candidate that loosens a safety invariant is rejected outright.

---

## 3. Branch management

Filesystem-only, no engine imports:

```
<repo>/.loom/tuner/
├── baseline/blueprint.json            # current baseline (the promoted Blueprint)
├── branches/<branchId>/
│   ├── blueprint.json
│   ├── hypothesis.json
│   └── results.json
├── history/<timestamp>/blueprint.json # every promoted baseline, never overwritten
└── reports/<timestamp>/
    ├── index.html
    ├── summary.json
    └── branches/<branchId>/{diff.txt,results.json}
```

Operations: `copyBaseline(branchId)`, `applyChanges(branchId, changes)`, `validate(branchId)`, `archiveBaseline()`, `restore(timestamp)`. Paths are confined to the tuner directory; escape is prevented.

---

## 4. Scoring and comparison

Per candidate:

- **Improved** — held-out suite score exceeds the baseline by more than the confidence interval and the configured `improvementMargin`.
- **Regressed** — any benchmark that the baseline passes now fails.
- **Noise** — everything else.

Only `improved` and non-regressing candidates are eligible for merge. The margin exists so the loop chases signal, not sampling noise.

---

## 5. Guardrails

| Guard | Fires when |
|---|---|
| Cycle budget | `maxCycles` reached. |
| Cost budget | Tuner + evaluation spend exceeds `maxCostUsd`. |
| Plateau | No candidate improved for `plateauLimit` consecutive cycles. |
| Safety | A candidate violates the promotion contract. |

Termination is a pure function `shouldTerminate(state, config)`, testable in memory. A no-op hypothesis (wording that does not move the score) is a **discard**, not a termination reason.

---

## 6. Promotion and rollback

`promote` is the **sole writer** of the baseline Blueprint.

- Writes the new baseline.
- Copies the previous baseline into `history/<timestamp>/` first — history is never overwritten.
- Is serialized (v1 assumes a single tuner process).
- Provides `restore(timestamp)` for rollback.

Promotion happens only after the merged candidate is evaluated against the **full held-out split** — not just the benchmarks the individual hypotheses targeted.

---

## 7. Reporting

Every cycle writes a report a human can act on: hypothesis summaries, a branch score table with confidence intervals, accept/reject/merge status with reasons, the new-baseline diff, and links to the run ids that produced each number. Workspace-derived content is HTML-escaped; model-authored summaries are treated as untrusted output.

---

## 8. Why this is a separate program

The tuner is an **HTTP client** of the engine plus a **Docker/git orchestrator** plus a **big-model caller**. It never imports the engine's internals. This keeps the engine clean, makes the tuner independently testable, and means a broken tuner cannot corrupt a production run.

---

## 9. Acceptance tests (M6)

- A full cycle runs end-to-end and produces a report.
- A candidate that improves by the configured margin is promoted; a regressing candidate is never promoted.
- A hypothesis producing an invalid Blueprint is dropped with the reason recorded.
- A candidate that weakens a safety invariant is rejected by the promotion contract before evaluation.
- Held-out gating blocks a candidate that overfits the tuning split.
- `restore(timestamp)` returns the baseline to a prior state exactly.
