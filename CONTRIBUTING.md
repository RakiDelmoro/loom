# Contributing

Development setup and conventions for Loom. For the rules that govern every
change, read [`AGENTS.md`](AGENTS.md). For the design, read [`plan/`](plan/).

## Requirements

- [Bun](https://bun.sh) 1.4 or newer.
- `git` (the engine's isolation model is built on git worktrees).

## Setup

```bash
bun install
```

## Commands

```bash
bun run typecheck       # tsc --noEmit; must be clean
bun test                # the fast suite; in-memory, milliseconds
bun run test:git        # the opt-in lane that runs real git against a temp repo
bun run loom --help     # run the CLI from source
```

There are no runtime dependencies. The only dev dependencies are `@types/bun`
and `typescript`, and that is deliberate — see "No dependencies" in
[`AGENTS.md`](AGENTS.md).

## Using the CLI

```bash
bun run loom --version
bun run loom blueprint validate loom.json
```

Validating the shipped Blueprint is the smoke test for the Blueprint layer:

```
loom.json: ok — entry role "orchestrator", 5 role(s), 7 tool(s)
```

A rejected Blueprint reports the exact path that is wrong and exits non-zero:

```
/tmp/broken.json: invalid
  /tmp/broken.json.roles.orchestrator.tools[0]: tool "ghost_tool" is not declared in tools
```

## Layout

```
loom.json      the example Blueprint (roles, tools, routing, budgets, alerts)
loom.deployment.json  providers, endpoints, and model prices; credentials are
               named here and read from the environment, never stored
tools/         tool manifests, referenced by path from the Blueprint
prompts/       role system prompts, referenced by path from the Blueprint
plan/          the design documents and roadmap
source/           the engine
```

Inside `source/`, code is one of three things — a leaf, an orchestration function,
or a pure helper. The decision tree is in [`AGENTS.md`](AGENTS.md); put a new
function in the right tier before writing it.

## Tests

Two lanes.

**`bun test` — the fast lane.** Tests are colocated with the code they cover
(`foo.ts` → `foo.test.ts`). They must be in-memory: no network, no filesystem, no
subprocess. Inject a fake at the leaf and exercise the real logic above it. The
filesystem is faked with `createMemoryFileSystem`, the model with
`createFakeProvider`, and git with a scripted `GitRunner` that records every
command it is asked to run.

**`bun run test:git` — the integration lane.** Some properties belong to real
git and cannot be proven against a fake. That one agent's files are invisible to
another is the entire point of the worktree manager, and only real git can
demonstrate it. This lane runs against a throwaway repository in the temp
directory, and every test in it is skipped unless `LOOM_GIT_TESTS=1` — which the
script sets. Run it before trusting any change to `source/workspace/`.

## Commits

Keep the tree green: `bun run typecheck` and `bun test` must both pass before a
commit. A commit that describes unshipped behaviour in a document is a bug —
update the document or drop the claim.
