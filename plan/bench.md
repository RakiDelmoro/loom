# Evaluation — the bench

**This is the moat.** The tuner is only as good as the number it optimizes, and a bad number is worse than no tuner because it produces confident nonsense. The reference implementation shipped nine toy benchmarks with pass/fail scoring and deferred the rest; Loom builds the bench *before* the loop.

> Rule: **no tuner work starts until the bench can distinguish a better Blueprint from a luckier one.**

---

## 1. What a benchmark is

A self-contained folder: an initial workspace, a task, and a way to decide whether the task was done.

```
benchmarks/<name>/
├── spec.json          # task text + validation + metadata (NEVER copied into the workspace)
├── README.md          # human-facing description
├── workspace/         # the initial files the agent sees
└── ...                # anything else the workspace needs
```

```jsonc
// spec.json
{
  "id": "fix-null-deref-001",
  "taskType": "bugfix",
  "difficulty": "medium",
  "task": "Fix the null dereference in src/parser.ts reported by the failing test.",
  "validation": {
    "command": "bun test",
    "expectedExitCode": 0,
    "expectedFiles": ["src/parser.ts"],
    "expectedStdoutContains": ["pass"],
    "timeoutSeconds": 120
  },
  "judge": { "rubric": "Does the fix address the root cause rather than the symptom?" },
  "humanResponses": { "Which parser version?": "The one in src/." }
}
```

`spec.json` is deliberately **not** copied into the workspace: the agent must not be able to read the test it is graded against.

---

## 2. Validation — deterministic first, judge second

**Layer 1: deterministic.** Files exist; command exits with the expected code; stdout contains the expected substrings. Binary, reproducible, cheap. Most benchmarks should be gradable here alone.

**Layer 2: LLM judge.** For work that is not binary — a design, a refactor, a doc — a judge model scores against a rubric with a small ordinal scale (0–3). The judge is a **routed model call** (see [model-routing.md](model-routing.md)), so the judge can be stronger than the worker, and it is never the same model instance that produced the work.

A benchmark may declare either layer or both. When both exist, the deterministic result gates the judge: a failed command short-circuits to fail.

**Judges are a measured liability.** A judge that is itself noisy destroys the bench. Mitigations: rubric-pinned prompts, temperature 0, the judge sees the diff and the task but not the author, and judge-vs-human agreement is spot-checked on a labeled subset (a backlog item: a small human-labeled calibration set).

---

## 3. The runner

For each benchmark, for each repetition:

1. **Isolate.** Copy the benchmark workspace into a fresh tree (a git worktree of the suite repo, or a temp dir) — never run in the benchmark's canonical folder. One benchmark's installs or downloads must not touch another's.
2. **Drive.** Submit the task to the engine against that tree, with the Blueprint under test, and a fixed effort/seed.
3. **Collect.** Wait for terminal state under a timeout; capture status, cost, tokens, wall time, and the final tree.
4. **Validate.** Run deterministic validation; then the judge if declared.
5. **Teardown.** Stop everything and remove the tree — on success, error, **and** timeout.

**Repetitions.** `repetitionsPerBenchmark` (default 3) — LLM work is stochastic, and a single sample is a coin flip. Results are aggregated across repetitions with the spread reported, not hidden.

**Human simulation.** A benchmark may declare `humanResponses`. When the Blueprint contains an `ask_human` tool, the bench answers from those responses (near-exact match) before falling back to a persona model, so a suite run is reproducible.

---

## 4. Scoring

Per benchmark, per repetition:

```
score = correctness − humanQuestionPenalty · askCount
```

where `correctness ∈ [0,1]` is 1 for a deterministic pass, the normalized judge score otherwise, and 0 for a failure.

Per Blueprint (the suite score):

```
suiteScore = weightedMean(benchmarkScore) − costPenalty − latencyPenalty
```

- **Variance.** Report the suite score with a confidence interval over repetitions. A difference smaller than the interval is **not** an improvement.
- **Cost and latency are terms, not dashboards.** If they are not in the score, the tuner will happily buy quality with unbounded spend.

---

## 5. The held-out split — the anti-overfitting gate

The suite is split once, deterministically:

- **Tuning split** — the tuner sees these results and optimizes against them.
- **Held-out split** — the tuner never sees these results during hypothesis generation or branch selection. Promotion requires improvement **on the held-out split**.

Without this, the loop overfits prompts to the visible benchmarks and reports a rising number that means nothing. The split is enforced **structurally**: the tuner is handed only optimization-split results, and the held-out evaluation runs in a separate step whose inputs the tuner cannot read.

---

## 6. Regression tracking

Every suite run appends a record: Blueprint hash, base ref, per-benchmark results, aggregate score, cost, timestamps. Over time this is the project's memory of what actually got better. A promotion that improves the mean while regressing a previously-passing benchmark is flagged and rejected by default (configurable).

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
- Re-running the same Blueprint and base ref yields a score inside the reported interval.
- A deliberately degraded Blueprint (e.g. reviewer tools stripped, prompts truncated) scores measurably lower.
- A benchmark whose command fails is a `fail`, not an `error`; a benchmark whose run crashes is an `error`, and the distinction is preserved in the aggregate.
- Teardown is verified on success, error, and timeout paths.
- The held-out split is unreachable from the tuner's inputs (asserted by an integration test, not by convention).
