# Evaluation — the bench

**This is the moat.** The tuner is only as good as the number it optimizes, and a bad number is worse than no tuner because it produces confident nonsense. The reference implementation shipped nine toy benchmarks with pass/fail scoring and deferred the rest; Loom builds the bench *before* the loop.

> Rule: **no tuner work starts until the bench can distinguish a better Blueprint from a luckier one.**

---

## 1. What a benchmark is

A self-contained folder: an initial workspace, a task, and a way to decide whether the task was done.

```
benchmarks/
├── suite.json         # which benchmarks are optimization, and which are held out
└── <name>/
    ├── spec.json      # task text + validation + metadata (NEVER copied into the workspace)
    └── workspace/     # the initial files the agent sees, and nothing else
```

```jsonc
// benchmarks/<name>/spec.json
{
  "id": "fix_off_by_one",            // must match the directory name
  "taskType": "bugfix",
  "difficulty": "medium",
  "task": "The test in src/range.test.ts fails. Fix src/range.ts. Do not change the tests.",
  "validation": {
    "command": "bun test",
    "expectedExitCode": 0,           // optional, defaults to 0
    "expectedFiles": ["src/range.ts"],
    "expectedStdoutContains": ["pass"],
    "timeoutSeconds": 120            // optional, defaults to 120
  },
  "judge": { "rubric": "Does the fix address the root cause rather than the symptom?" }
}
```

```jsonc
// benchmarks/suite.json — every benchmark belongs to exactly one split
{
  "optimization": ["fix_off_by_one", "fix_import_path", "implement_clamp", "add_default_parameter"],
  "heldOut": ["fix_string_case", "add_export"],
  "judge": { "provider": "together", "model": "deepseek-ai/DeepSeek-V4.1-Flash" }  // optional
}
```

`spec.json` is deliberately **not** copied into the workspace: the agent must not be able to read the test it is graded against.

---

## 2. Validation — deterministic first, judge second

**Layer 1: deterministic.** Files exist; command exits with the expected code; stdout contains the expected substrings. Binary, reproducible, cheap. Most benchmarks should be gradable here alone.

**Layer 2: LLM judge.** For work the command cannot fully describe — a refactor that must keep the tests green while improving structure, a design, a document — a judge model scores against a rubric on a small ordinal scale (0–3), normalized to 0–1. The judge is a routed model call (see [model-routing.md](model-routing.md)), so it can be stronger than the worker.

**The command gates; the judge grades above it.** A deterministic failure is a failure, full stop — a judge can never rescue work whose tests fail. A deterministic pass with a declared judge is scored by the rubric, so the judge can *demote* work that passes the tests but is poor.

**Judges are a measured liability.** A judge that is itself noisy destroys the bench. Mitigations: rubric-pinned prompts, temperature 0, the judge is told the task and what the checks observed but **never who produced the work**, and judge-vs-human agreement is spot-checked on a labeled subset (a backlog item: a small human-labeled calibration set). A judge that cannot be reached leaves a passing run scored 1 rather than silently zeroing it.

---

## 3. The runner

For each benchmark, for each repetition:

1. **Isolate.** Copy the benchmark's `workspace/` into a fresh temp directory and initialize it as a git repository with one commit. The engine needs a repository (it branches agents from a commit), and the copy is what keeps one benchmark's installs or downloads out of another's.
2. **Drive.** Run the task against that copy, with the Blueprint under test and `auto` autonomy — so the agents' branches are merged and validation sees the system's *real* output, merge included.
3. **Collect.** Capture status, cost, wall time, and the run id.
4. **Integrity.** Refuse to score a run whose workspace is not the system's output. Two conditions disqualify it: a **merge that did not land** (a conflict, or a base tree too dirty to merge into), and a **base repository left with uncommitted changes** — which means something wrote outside its worktree, because the worktree is where a write is supposed to land and the merge is how it is supposed to arrive. A disqualified run is an `error` carrying the reason, and it is checked **before** validation: reading a tree the run did not produce is worse than useless, and a passing test suite on such a tree is exactly the false credit this gate exists to refuse.
5. **Validate.** Deterministic checks first; then the judge, if the benchmark declares one and the checks passed.
6. **Teardown.** Remove the copy — on success, error, and a thrown exception alike. A leaked workspace is a bug, and a suite creates one per repetition.

The integrity gate is not decoration. Before it existed, a real-model run passed `implement_clamp` at 1/1 while the change it was credited for had arrived by a shell heredoc written into the *base* repository, bypassing every worktree and every merge — and both candidate branches were left unmerged. The score was an artifact of an escape, not a measurement of the system.

**Repetitions.** `--repetitions` (the plan's `repetitionsPerBenchmark`) — LLM work is stochastic, and a single sample is a coin flip. Results are aggregated across repetitions with the interval reported, not hidden.

**A run that cannot start is an `error`, not a `fail`.** The distinction matters: a broken harness must not look like a failing candidate.

---

## 4. Scoring

Per benchmark, per repetition:

```
score = 1                                  when the deterministic checks pass (no judge declared)
score = the judge's normalized score       when they pass and a judge is declared
score = 0                                  when they fail
```

Per Blueprint (the suite score): the **mean of those scores**, reported with a **95% Wilson interval**.

- **Variance.** A difference smaller than the interval is **not** an improvement. This is the rule that stops the loop chasing noise.
- **Cost and latency are reported, not folded in.** Turning dollars into "correctness points" needs an exchange rate, and inventing one in the bench would be worse than exposing both numbers and letting the comparison rule decide. A run that scores well but costs a fortune is visible as exactly that.
- **Spend is measured, never enforced** — see [model-routing.md](model-routing.md) "Spend visibility, not enforcement".

The human-question penalty from earlier drafts arrives with the `ask_human` tool, which does not exist yet.

---

## 5. The held-out split — the anti-overfitting gate

The suite is split once, deterministically:

- **Optimization split** — the tuner sees these results and optimizes against them.
- **Held-out split** — the tuner never sees these results during hypothesis generation or branch selection. Promotion requires improvement **on the held-out split**.

Without this, the loop overfits prompts to the visible benchmarks and reports a rising number that means nothing. The split is enforced **structurally**: `suite.json` must partition the benchmark directories (a benchmark in neither split is rejected, and so is one in both), and a run selects exactly one half — the held-out benchmarks are never executed during an optimization run, so their results cannot exist to leak.

---

## 6. Regression tracking

Every suite run writes `<repo>/.loom/bench/<timestamp>.json` — the whole result, including per-benchmark summaries, every outcome with its reasons, the interval, cost, and timing. Over time this is the project's memory of what actually got better. A promotion that improves the mean while regressing a previously-passing benchmark is flagged by the tuner and rejected by default.

---

## 7. Suite composition

A useful suite is not ten variations of one task. Aim for:

- **Difficulty spread** — easy / medium / hard, so partial progress is visible and the score is not a floor or a ceiling.
- **Type spread** — bugfix, feature, refactor, docs, and at least one multi-file task that requires the fan-out path.
- **A floor** — at least one task the baseline reliably passes, so a broken Blueprint scores 0 and the bench's own health is visible.
- **A ceiling** — at least one task the baseline reliably fails, so there is headroom to measure improvement.

---

## 8. Acceptance tests (M5)

- A suite of ≥5 real tasks runs end-to-end and emits a reproducible score.
- Re-running the same Blueprint yields the same score and the same per-benchmark results.
- A deliberately degraded Blueprint scores measurably lower, with **non-overlapping intervals** — the check that makes the scoreboard trustworthy.
- A benchmark whose command fails is a `fail`; a benchmark whose run does not finish is an `error`, and the distinction is preserved.
- Teardown is verified on the success, error, and thrown-exception paths.
- The held-out split is never executed during an optimization run — asserted, not assumed.
- Every benchmark's tests must fail before the run: a benchmark that already passes measures nothing.
