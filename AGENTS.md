# AI Agent Guidelines

These rules govern every change to Loom. They are not suggestions; a change that
breaks one is a bug even when the tests pass.

The design these rules serve lives in [`plan/`](plan/). When this document and
the code disagree, fix the code or fix this document in the same change.

## Vocabulary

Use these names, and only these:

| Name | What it is |
|---|---|
| **Blueprint** | the config file — roles, tools, routing, budgets, permissions |
| **Engine** | the program that runs a Blueprint |
| **Tuner** | the offline loop that improves a Blueprint |
| **Bench** | the scoreboard — benchmarks, scoring, the held-out split |

Never reintroduce `Org`, `Runtime`, or `Optimizer`, and never borrow the
reference project's `Guild`, `Executor`, or `Foundry`. A **benchmark** is one
task; the **Bench** runs them all.

---

## Project-wide principles

### No dependencies

The project must not gain a runtime or dev dependency beyond what is already in
`package.json` (`@types/bun`, `typescript`). Everything else uses Bun built-ins
and web-standard APIs. This keeps the supply chain auditable and the deployment
tiny.

If a dependency seems necessary, do not add it unilaterally. Look for an
alternative first — reimplement with built-ins, restructure the code, or split
the work differently. If none exists, ask before adding anything and explain
what you considered.

### Code quality over speed

Prefer clear names, small focused functions, and obvious control flow over clever
or compact code. A reviewer should understand any change without a further
explanation.

### In-memory, fast tests

Tests must not touch the network, the filesystem, or a subprocess, and must not
depend on external services. Every test runs in milliseconds, so running the
whole suite is never a burden. Fakes go in for the model, the filesystem, and
subprocess leaves.

### Two lanes

When the subject *is* an external system — real git, a real subprocess — its
behaviour cannot be verified in memory. Those checks live in an opt-in
integration lane guarded by an environment variable and run by their own script
(`bun run test:git`), so the fast suite stays clean. The integration lane proves
the property; the fast lane proves the logic around it. A change to
`source/workspace/` is not trusted until both pass.

### Testable business logic

Structure code so that parsing, validation, formatting, transformation, and
decision-making live in pure functions or orchestration functions that receive
their dependencies explicitly. Keep integration glue thin. If a piece of logic is
hard to test, that is the signal to move it into the testable surface area.

### Maintainable and auditable

Prefer explicit data flow over hidden globals. Validate every external input.
Behaviour should be discoverable by reading the code, not from tribal knowledge.

---

## Type safety

### No typecasts

Never use `as Type` to silence the type checker. It hides real mismatches. If
typecheck fails, the types are wrong — fix them.

The one legitimate narrowing tool is a type guard, and the package has exactly
one canonical object guard: `isRecord`, exported from `source/guards.ts`. Import it;
never redefine it at a call site. It proves a value is a plain object, never what
its fields are, so still check each field you read.

### Validate external data

Data crossing into the program — a Blueprint, a tool manifest, a provider
response, an environment value — is `unknown` until proven otherwise. Validate it
at the boundary and carry the **path** of the offending value in the error, so a
config typo is fixable without a debugger.

### No non-null assertions

Never use `value!`. It is a typecast in disguise: it declares a value present
without proving it, and fails as an opaque error far from the cause. Restructure
so absence is handled explicitly, or fail fast with a useful message. Optional
chaining (`?.`) and nullish coalescing (`??`) are fine — they are not assertions.

---

## Error handling

### No try/catch for control flow

Do not use try/catch to check whether something exists or to handle a condition
you could have checked. Check first, then act.

### Expected versus exceptional

- **Expected** (check before proceeding): file existence, user input, config
  presence, HTTP status, a missing key.
- **Exceptional** (try/catch is correct): a network failure mid-request, an I/O
  fault after an existence check, `JSON.parse` on text that is not JSON — the
  conditions that cannot be checked before they happen.

### Leaves report failures as values

A leaf that can fail for an expected reason returns a discriminated result
(`{ kind: 'ok', … } | { kind: 'unreadable', … }`) rather than throwing. The
caller decides what a missing file means; the leaf does not.

### Failures are typed results, not exceptions

Model calls, tool calls, and agent runs resolve to a typed result
(`unavailable`, `timeout`, `permission_denied`, `budget_exceeded`, …). A caller
recovers by branching on the kind. Recovery policy belongs to the Blueprint, not
to the engine.

---

## Testing policy

### Testable — write tests

Pure functions and orchestration functions: parsing, validation, formatting,
transformation, decision-making, sequencing.

### Not testable — do not write tests

Thin integration glue: the CLI's `main`, `source/serve.ts`, the factory that wires
real leaves. Keep these as thin as possible so there is little logic in them
worth testing.

### Dependencies are injected

A function that touches an external system receives it. Leaves are exported as
**factories** that close over configuration and return a configured function.

**No `dependencies` parameter has a default value.** `main` (or the CLI) is the
only place that assembles and passes real dependencies. A default hides external
access and surprises the caller.

### Assert behaviour, not implementation

A test earns its place only if a plausible bug would fail it. Test boundaries,
invariants, transitions, precedence, and real errors — not plumbing, not field
copies, not source text. Never write a test so a change merely "has tests".

---

## Architecture

Three tiers. Decide which one a new function belongs to before writing it.

### Leaf functions

Touch an external system: network, filesystem, subprocess, environment. **Not
tested.** The thinnest possible wrapper. Exported as a **factory** that closes
over configuration which does not vary per call.

Examples: `source/cli.ts`'s `readTextFile`, the injected `fetch` in
`source/model/openai.ts`.

### Orchestration functions

Sequence calls, make decisions, handle errors, branch. **Tested.** They receive a
`dependencies` object containing only the configured leaf functions they
*directly* use. List each dependency explicitly in the function's own type; do
not compose dependency types with `&`.

Examples: `loadBlueprint` in `source/blueprint/load.ts`.

### Pure helper functions

Parsing, validation, formatting, transformation, decision-making. **Tested.**
Imported directly wherever needed and never injected.

Examples: everything in `source/blueprint/parse.ts`, `parseChatCompletion` in
`source/model/openai.ts`, `routeRole` in `source/model/router.ts`.

### Decision tree

1. Does it touch an external system?
   - **Yes** → a leaf. Export a factory. Do not test it directly.
   - **No** → go to 2.
2. Does it orchestrate or decide?
   - **Yes** → orchestration. Take a `dependencies` object, no defaults. Test it.
   - **No** → a pure helper. Import it directly. Test it.

### Rules

- **Only leaves go in `dependencies`.** Plain data, configuration, and user input
  are ordinary parameters.
- **Pass the accumulated `dependencies` object down** rather than repackaging it.
  Structural typing means a handler accepting a subset type still accepts the
  whole object, and the checker surfaces a missing dependency at the call site.
- **Do not export a function solely for a test.** If it is not reachable through
  the module's public surface, it should not be tested.
- **Avoid one-line wrappers.** A function whose whole body is a single expression
  earns its name only if it is a type guard, has three or more call sites needing
  lockstep behaviour, or names a non-obvious rule. Otherwise inline it.

---

## Layout

```
loom/
├── loom.json          the example Blueprint
├── tools/             tool manifests referenced by the Blueprint
├── prompts/           role system prompts referenced by the Blueprint
├── plan/              the design and roadmap (documents, not code)
└── source/
    ├── cli.ts         the `loom` command (glue)
    ├── errors.ts      ValidationError, describeError
    ├── fs.ts          the filesystem boundary (types only)
    ├── node-fs.ts     the real filesystem leaf
    ├── guards.ts      the canonical isRecord guard
    ├── agent/         the agent loop and its result types
    ├── blueprint/     types, parsers, loader
    ├── model/         provider interface, fake, openai client, router
    ├── scheduler/     the bounded pool and the agent-tree scheduler
    ├── tools/         tool types, registry, and the built-in tools
    ├── workspace/     naming, git exclude, the git leaf, the worktree manager
    └── test-support/  shared test doubles (support code, not tests)
```

Tests are colocated: `foo.ts` is covered by `foo.test.ts`.
