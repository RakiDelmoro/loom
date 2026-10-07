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
4. **Evaluate.** Run each candidate against the **optimization split** of the suite via the bench.
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
    { "path": "loom.json", "content": "<complete new file content>" }
  ]
}
```

An edit is the **complete new file content**, never a patch: no patch engine, and every branch is auditable by diffing whole files. This is the reference implementation's choice and it is a good one — keep it.

**The tuning space:** prompt wording across all roles; routing profile assignments (which role uses which model — the highest-leverage, cheapest edit); the review-round caps; per-role tool lists; numeric budgets (`maxAgentDepth`, `maxConcurrentAgents`, `toolTimeoutSeconds`); and structural hypotheses (adding or removing a role, rewriting the entry prompt).

**Constraints the loop must respect** (or the tuner will cheat):

- It may **not** touch the deployment file, credentials, or prices — that file lives outside the guild directory, so a candidate cannot reach a secret or a price by construction.
- It may **not** weaken `permissions.mode`.
- It may **not** leave a role able to change the workspace without worktree isolation.

These are checked by the **promotion contract**, and a candidate that breaks one is rejected **before it is evaluated** — a search left to itself will trade safety for score, and refusing early means the bad idea costs no benchmark run.

**Deliberately not in the contract:** granting a role a new tool. Whether a reviewer that can *edit* helps or hurts is a **quality** question, and the bench is the arbiter. The contract refuses only what is unsafe — containment and permissions — because a contract that also encodes taste would quietly freeze the design.

---

## 3. Branch management

Filesystem only, and confined to the tuner's own directory:

```
<repo>/.loom/tuner/
├── branches/<branchId>/guild/       # a candidate: loom.json + the prompts and tools it references
├── history/<timestamp>/             # every replaced baseline, never overwritten
└── reports/<timestamp>/             # index.html + summary.json
```

A branch holds **exactly the files the Blueprint references** — the document, each role's prompt and style guide, and each tool manifest. Not a directory copy: the guild sits inside the project it describes, and copying the directory would sweep up the repository around it.

Every branch is validated with the **same loader a run uses**, so a candidate that cannot run is never evaluated — and a candidate that loads will behave in a benchmark exactly as it would in production.

**A change to a path the Blueprint does not reference is refused, not written.** Such a file is read by nothing, so the candidate is the baseline plus a stray file — a no-op that scores identically and reads as a hypothesis that did not help. It is the most expensive kind of bug this system can have, because the search appears to run: three real cycles were spent evaluating candidates the proposer had aimed at `blueprint.json` when the document is `loom.json`, and every verdict was a verdict about the baseline. Two changes came out of it. The branch manager now fails such a candidate by name, listing the files a change may target. And the proposal prompt is given that list, because a proposer that has to guess its own configuration's filename will guess wrong.

### The prompt is told what it may edit

The proposer receives the Blueprint document, **the exact files a change may name**, and the models the deployment prices. Each of those was added after a cycle failed for the want of it. A model asked to name a cheaper route it has never heard of cannot; a model asked to edit "the Blueprint" without being told which file that is writes a new one. Neither is a reasoning failure — both are the harness withholding a fact the model had no way to obtain.

---

## 4. Scoring and comparison

Per candidate, against the baseline's **optimization** score:

- **Regressed** — any benchmark the baseline passed and the candidate does not, whatever the mean says. Averaging hides exactly the damage a user would notice.
- **Improved (score)** — the candidate's interval **lower bound** clears the baseline's measured score by at least `improvementMargin`. The pessimistic reading of the candidate still has to win.
- **Improved (cost)** — no regression, a score at least as good, and a cost at least `costMargin` below the baseline's — **and only with `repetitions` above 1**.
- **Noise** — everything else.

Regression is checked first, so a candidate can never buy a win by breaking something that already worked. Only `improved` candidates are eligible for merge.

**Why there are two ways to win.** When the suite is harder than the model, pass rate is the axis and the interval rule is the whole defence against chasing variance. When the model is *stronger* than the suite — the baseline passes everything — pass rate cannot move, and the only thing left to improve is what the run spends. A score-only rule leaves the Tuner with nothing to optimize, and it is not hypothetical: routing both roles to a cheaper model scored **identically, for 2.6× less** ($0.0437 → $0.0166), and a score-only comparison called it noise and discarded it.

**Why cost needs repetitions, and score does not.** A score has a Wilson interval, so a single run still carries its own uncertainty and the rule can be pessimistic without more data. Cost has no interval — one number, varying with how many turns the model chose to take. That variation is not small. A candidate that changed *nothing* — it set an option to the value it already had — measured **25% cheaper** than the baseline it was identical to, cleared a 20% margin, and was promoted, while a genuine 15% saving in the same cycle was declined. Averaging is the only thing that separates a saving from that, and one repetition averages nothing. Below two repetitions a cheaper candidate is reported as **unconfirmed** rather than promoted, so the reason reads as the measurement being distrusted rather than as cost being ignored.

The cost rule is guarded on both ends. A baseline that spends nothing has no saving to find, so every free candidate would otherwise look like a win; and the reason names the **latency** the saving cost, because cheaper is not free if it is much slower (`0.0437/189s` against `0.0166/669s` is one measured trade, and the operator reads it in the report rather than discovering it later).

Once the accepted candidates are merged, the **merged** artifact is evaluated on the held-out split against the baseline's held-out score, by the same rule. Promotion requires `improved` there. Combining two good branches can still produce a bad one, so the merge is re-evaluated rather than assumed.

---

## 5. Guardrails

| Guard | Fires when |
|---|---|
| Cycle budget | `maxCycles` reached. |
| Cost budget | The **Tuner's own** spend on optimization cycles exceeds its configured ceiling. This is the offline optimizer's budget, not the engine's: a *run* is never stopped over spend (see [model-routing.md](model-routing.md)). |
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

## 8. How the tuner is packaged

The tuner is a **subcommand** — `loom tune` — in the same project as the engine, and it shares the Blueprint loader and the bench **by import**.

That is a deliberate departure from "a separate program": branch validation has to be *identical* to a run's validation, and the bench has to be *identical* to the one that scores production candidates. Duplicating either would let them drift, and a drifted benchmark is worse than no benchmark.

What it still does not do:

- It never runs inside the serving process. It is an offline command you invoke deliberately.
- It never touches the deployment file, passwords, or prices.
- It cannot corrupt a run: it writes only under `.loom/tuner/`, and the baseline only through `promote`.

---

## 9. Acceptance tests (M6)

- [x] A full cycle runs end-to-end and produces a report.
- [x] A candidate that improves by the configured margin is promoted; a regressing candidate is never promoted.
- [x] A hypothesis producing an invalid Blueprint is dropped with the reason recorded.
- [x] A candidate that weakens a safety invariant is rejected by the promotion contract **before** evaluation — and never costs a benchmark run.
- [x] Held-out gating blocks a candidate that overfits the optimization split.
- [x] `restore(timestamp)` returns the baseline to a prior state exactly.
- [x] A promoted baseline is archived first, so promotion is reversible.
