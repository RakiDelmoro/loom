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
bun test                # the whole suite; in-memory, milliseconds
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
loom.json      the example Blueprint (roles, tools, routing, budgets, permissions)
tools/         tool manifests, referenced by path from the Blueprint
prompts/       role system prompts, referenced by path from the Blueprint
plan/          the design documents and roadmap
src/           the engine
```

Inside `src/`, code is one of three things — a leaf, an orchestration function,
or a pure helper. The decision tree is in [`AGENTS.md`](AGENTS.md); put a new
function in the right tier before writing it.

## Tests

Tests are colocated with the code they cover (`foo.ts` → `foo.test.ts`) and run
under `bun test`. They must be in-memory: no network, no filesystem, no
subprocess. Inject a fake at the leaf and exercise the real logic above it.

The filesystem is faked by passing a `readTextFile` function; the model is faked
by `createFakeProvider`. Neither the real filesystem nor a real endpoint is ever
touched in a test.

## Commits

Keep the tree green: `bun run typecheck` and `bun test` must both pass before a
commit. A commit that describes unshipped behaviour in a document is a bug —
update the document or drop the claim.
