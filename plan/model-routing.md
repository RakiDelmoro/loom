# Model Routing

**One model, guided by the Tuner.** This document specifies the provider abstraction, the routing profiles, cost accounting, and budget enforcement — the *mechanism* by which a Blueprint names the model it runs, and by which a role carries its own temperature.

It is not a licence to split a run across models. The project's question is whether **one** model, set up well, can do real engineering work, so the Tuner's search is pinned to the model the baseline runs: a run that quietly hands its hard calls to a stronger model has answered a different question, and a candidate that wins by naming a different model has taught nothing about guiding this one.

Hybrid routing — local models for cheap mechanical roles, cloud models for hard ones — remains available, and the cost case for it is below. What changed is its status: it was a founding posture, and it is now an option an operator can take deliberately, one Blueprint at a time.

The mechanism earns its place even with a single model: routing is where a model is named, it carries a per-role temperature, and it is what `--model-override` overrides.

---

## 1. Provider interface

One interface, three implementations.

```ts
interface ChatRequest {
  model: string
  system: string
  messages: Message[]
  tools: ToolSpec[]
  temperature: number
  maxTokens: number
  signal?: AbortSignal
}

interface ChatResponse {
  content: string
  reasoning?: string
  toolCalls: ToolCall[]
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error'
}

interface Provider {
  readonly id: string
  chat(request: ChatRequest): Promise<ChatResponse>
}
```

Every provider returns the **same** shape, so the engine never branches on vendor. Failures are typed results, not exceptions: `unavailable`, `timeout`, `rate_limited`, `invalid_response`.

### `openai-compatible` (the only client)

`POST {baseUrl}/chat/completions` with `tools`. Covers OpenAI, llama.cpp server, Ollama, vLLM, LM Studio, OpenRouter, Together, and most cloud gateways. This one client is why the local/cloud split is cheap to build — the same code talks to a laptop and to a frontier API.

The response parser is deliberately tolerant of the shapes gateways actually send: a `null` `content` alongside tool calls, reasoning under `reasoning_content`, and cached prompt tokens under `prompt_tokens_details.cached_tokens` for honest cost accounting.

### `fake`

A scripted provider for tests: a queue of responses, optional artificial latency, deterministic usage numbers. **All unit tests use it.** No test hits the network.

**An Anthropic-native client is not built.** Anthropic's messages API differs enough to need its own mapping (`/v1/messages`, tool-use blocks), and the OpenAI-compatible client cannot reach it. Every provider in a deployment file must be one an OpenAI-compatible endpoint sits behind — a provider name is not a client.

---

## 2. Profiles

The Blueprint names **profiles**; the deployment resolves them.

```jsonc
// loom.json (Blueprint) — behavior only
"routing": {
  "reasoner":   { "provider": "together", "model": "deepseek-ai/DeepSeek-V4.1-Flash", "temperature": 0.2 },
  "worker":     { "provider": "together", "model": "deepseek-ai/DeepSeek-V4-Flash-0731", "temperature": 0.1 },
  "summarizer": { "provider": "local",    "model": "qwen3-4b",                        "temperature": 0.0 }
}

// loom.deployment.json — endpoints, credentials, prices
"providers": {
  "together": { "baseUrl": "https://api.together.ai/v1", "apiKeyEnv": "TOGETHER_API_KEY" },
  "local":    { "baseUrl": "http://localhost:8080/v1" }
},
"prices": {
  "deepseek-ai/DeepSeek-V4.1-Flash":     { "inputPer1M": 0.30, "cachedInputPer1M": 0.006, "outputPer1M": 1.20 },
  "deepseek-ai/DeepSeek-V4-Flash-0731":  { "inputPer1M": 0.14, "cachedInputPer1M": 0.03,  "outputPer1M": 0.28 },
  "qwen3-4b":                             { "inputPer1M": 0.00, "cachedInputPer1M": 0.00,  "outputPer1M": 0.00 }
}
```

A profile is `{ provider, model, temperature, maxTokens? }`. A **role** references a profile name. A **run** may override:

```
loom run --task "..." --model-override coder=reasoner
```

So the same Blueprint runs cheap in development and strong in production without a single edit.

---

## 3. Cost accounting

Per call:

```
cost = inputTokens        / 1e6 * price.inputPer1M
     + cachedInputTokens  / 1e6 * price.cachedInputPer1M
     + outputTokens       / 1e6 * price.outputPer1M
```

`inputTokens` is the **full** prompt bill; `cachedInputTokens` is the subset the provider served from cache, billed at the cached rate. The uncached portion is `inputTokens - cachedInputTokens`, billed at the full rate. Local models priced at `0.00` still record tokens, so token budgets work regardless of cost.

Costs roll up: per call → per agent → per run. The manifest records all three, plus a per-model breakdown so a run can be attributed to the roles that spent the money.

---

## 4. Spend visibility, not enforcement

Loom **measures** spend and does **not** stop a run over it. That is deliberate: the engine is built to run unattended against cheap or local models, where a dollar ceiling either fires on healthy work or never fires at all — the same reasoning that keeps Loom from imposing a wall-clock timeout.

What actually bounds a runaway run is structural, not financial:

| Bound | What it limits |
|---|---|
| `budgets.maxAgentDepth` | Recursion — a tree cannot grow deeper than this. |
| `budgets.loopCheck` | A role that repeats itself is ended by the handler role with `loop_detected`. |
| `budgets.toolTimeoutSeconds` | A hung tool is aborted. |
| The deployment container | The outer boundary: `docker stop` ends a pathological run. |

Cost is recorded per call → per agent → per run, with a per-model breakdown, so a run is *attributable* even though it is never *interrupted*.

An optional `alerts` block in the Blueprint can name a dollar or token threshold. Crossing it emits an event and nothing else — an alert is a signal to look, never a lever that stops work.

---

## 4a. Sizing `maxConcurrentAgents` to the endpoint

`maxConcurrentAgents` is a **deployment** property, not a Blueprint ambition: it must
match how many requests the endpoint can actually generate at once. The executor
discovers `total_slots` from the endpoint's `/props` (llama-server exposes it) — set
the budget to that number, not to a wish.

A budget above the real slot count does not speed anything up: requests queue on the
server, and a client-side fetch timeout kills queued calls mid-wait, which turns
loaded runs into retry livelocks (observed: 2.5 hours of a coder's run spent
time-out → re-queue → time-out on a one-slot server under an 8-way budget).

One-slot deployments (a single 9B quantized model on one GPU) therefore run with
`maxConcurrentAgents: 1`. The Blueprint's parallel structure — fan-out, per-role
ceilings, worktree isolation — is unchanged; only the wall-clock overlap waits for
hardware that can honor it. On a multi-slot or API-backed deployment, raise the
budget to the slot count and the same Blueprint parallelizes.

## 5. Degradation and fallback

**Built:**

- **Provider unavailable.** Retried with bounded exponential backoff — 250ms, 500ms, 1s — and after exhaustion a typed `unavailable` result. On a local model this is not an edge case: `llama-server` answers `500` when it cannot parse a tool call a quantised model emitted, and dying on that would make autonomy impossible. Every attempt is billed, the discarded ones included.
- **An empty answer.** An endpoint returning neither content nor a tool call is retried the same way, then ends the role with `empty_completion`. It is *not* a finish: reading it as one produced a coder that reported `"Completed."` having committed nothing.
- **Rate limits.** `rate_limited` is a retryable typed result and is retried on the same schedule.
- **Unparseable answers.** `invalid_response` is deliberately **not** retried — the provider answered with nonsense, and asking the same thing again does not fix that.

Each retry is written to the event log as `model_retry`, so a recovery is visible rather than inferred from a run that mysteriously carried on.

**Described here, not built:**

- **A `fallback` profile.** The design is above; there is no `fallback` key in the Blueprint and no code that reads one. A role either reaches its endpoint or fails.
- **Context overflow → compact and retry.** There is no compaction and no handoff. This is the ceiling on long-horizon autonomy: a run that keeps working will walk into the model's context window, and nothing currently carries it past that. The reference's answer is a *handoff* — the role finishes with a brief and its parent re-delegates a fresh instance — and Loom has no equivalent.

---

## 6. Why this matters

The reference implementation's single-model design forces one of two bad outcomes: run everything on a small model (weak on hard roles) or everything on a big model (expensive on mechanical roles). Routing removes the trade-off. Concretely, a typical run's cost is dominated by a few hard calls; routing the summarizers, extractors, and formatters to a local model can cut spend by an order of magnitude at no measurable quality cost.

That trade is available to an **operator**, deliberately, one Blueprint at a time. It is not something the Tuner will find, because the search is pinned to one model: a saving that came from running the work on a different model would not tell you whether the setup improved, and the setup is the only thing this project is trying to learn about.

---

## 7. Acceptance tests (M0/M4)

- `openai-compatible` client: tool-call parsing, usage mapping, and error mapping tested against a fake `fetch`.
- Router: every role resolves to a profile; an unknown profile is a load error.
- Cost math: cached vs uncached input, zero-priced local models, and rounding are unit-tested.
- Alert: a scripted run that crosses its `alerts.costUsd` threshold emits an event and **runs to completion**.
