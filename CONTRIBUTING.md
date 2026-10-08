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

## Running a local model

The engine talks to any OpenAI-compatible endpoint, and `loom.deployment.json`
points `local` at `http://127.0.0.1:8080/v1`. On this machine that endpoint is
`llama-server` from `/opt/llama-cuda`, and **the CUDA runtime is not on the
default library path** — started without `LD_LIBRARY_PATH` the binary finds no
CUDA device, silently runs on the CPU, and goes five times slower (2 tokens/s
against 11). Check with `llama-server --list-devices`: it must print `CUDA0`.

```bash
export LD_LIBRARY_PATH=/opt/llama-cuda/cudart-llama-b11461-bin-ubuntu-cuda-12.8-x64
/opt/llama-cuda/llama-b11461/llama-server \
  -m Qwen3.5-9B-heretic-v2.Q4_K_M.gguf --jinja \
  -c 32768 -np 1 -ctk q8_0 -ctv q8_0 -fa on -ngl 99 \
  --host 127.0.0.1 --port 8080
```

None of those flags is arbitrary on an 8 GiB card:

| Flag | Why |
|---|---|
| `-c 32768 -np 1` | `-np` **divides** the context between slots. The default of 4 gives each request 8192 tokens, not 32768 — which is what the server was actually doing before this was set |
| `-ctk q8_0 -ctv q8_0` | f16 KV costs this model 128 KiB per token (32 layers, 4 KV heads, 256-wide keys). 32k of it is 4 GiB, which does not fit beside 5.3 GiB of weights. q8_0 halves it to 2 GiB, which does |
| `-fa on` | Flash attention — and the prerequisite for a quantised KV cache |
| `-ngl 99` | Every layer on the GPU |

Startup leaves about 7.4 GiB of the card in use. Verify the result rather than
trusting the flags:

```bash
curl -s localhost:8080/props | jq '{n_ctx: .default_generation_settings.n_ctx, total_slots}'
# { "n_ctx": 32768, "total_slots": 1 }
```

Context shift is disabled by default, so a prompt that overruns the context
errors loudly instead of quietly dropping the oldest messages — which is what an
agent loop wants, since the oldest message is usually the system prompt.

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
bun run loom bench --suite benchmarks --split optimization --repetitions 2
bun run loom tune --repo .
```

Validating the shipped Blueprint is the smoke test for the Blueprint layer:

```
loom.json: ok — entry role "orchestrator", 16 role(s), 12 tool(s)
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
tuner.json     the Tuner's configuration: the suite, the budgets, the big model
tools/         tool manifests, referenced by path from the Blueprint
prompts/       role system prompts, referenced by path from the Blueprint
benchmarks/    the benchmark suite: suite.json + one directory per task
benchmarks-v2/ the harder Rust suite, same layout
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
