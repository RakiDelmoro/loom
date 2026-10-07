# Model Routing

Hybrid routing is one of the three founding decisions: local models for cheap/mechanical roles, cloud models for hard roles. This document specifies the provider abstraction, the routing profiles, cost accounting, and budget enforcement.

The reference implementation has **no per-role model override** — one model serves every role. Routing is the single largest cost/quality lever in a multi-agent system, so here it is a first-class concept.

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

### `openai-compatible` (the workhorse)

`POST {baseUrl}/chat/completions` with `tools`. Covers OpenAI, llama.cpp server, Ollama, vLLM, LM Studio, OpenRouter, and most cloud gateways. This one client is why the local/cloud split is cheap to build — the same code talks to a laptop and to a frontier API.

### `anthropic`

`POST {baseUrl}/v1/messages`, mapping tool definitions and tool-use blocks to the same `ChatResponse`. Needed for first-class support of the strongest reasoning models.

### `fake`

A scripted provider for tests: a queue of responses, optional artificial latency, deterministic usage numbers. **All unit tests use it.** No test hits the network.

---

## 2. Profiles

The Blueprint names **profiles**; the deployment resolves them.

```jsonc
// loom.json (Blueprint) — behavior only
"routing": {
  "reasoner":   { "provider": "anthropic", "model": "claude-sonnet-4", "temperature": 0.2 },
  "worker":     { "provider": "local",     "model": "qwen3-coder-30b", "temperature": 0.1 },
  "summarizer": { "provider": "local",     "model": "qwen3-4b",        "temperature": 0.0 }
}

// loom.deployment.json — endpoints, credentials, prices
"providers": {
  "anthropic": { "baseUrl": "https://api.anthropic.com", "apiKeyEnv": "ANTHROPIC_API_KEY" },
  "local":     { "baseUrl": "http://localhost:8080/v1" }
},
"prices": {
  "claude-sonnet-4": { "inputPer1M": 3.00, "cachedInputPer1M": 0.30, "outputPer1M": 15.00 },
  "qwen3-coder-30b": { "inputPer1M": 0.00, "cachedInputPer1M": 0.00, "outputPer1M": 0.00 }
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
| The per-role turn limit | A single role cannot spin forever. |
| `budgets.toolTimeoutSeconds` | A hung tool is aborted. |
| The deployment container | The outer boundary: `docker stop` ends a pathological run. |

Cost is recorded per call → per agent → per run, with a per-model breakdown, so a run is *attributable* even though it is never *interrupted*.

An optional `alerts` block in the Blueprint can name a dollar or token threshold. Crossing it emits an event and nothing else — an alert is a signal to look, never a lever that stops work.

---

## 5. Degradation and fallback

- **Provider unavailable.** Retry with bounded exponential backoff; after exhaustion, a typed `unavailable` result. If the Blueprint declares a `fallback` profile for the role, the engine retries once on the fallback (e.g. cloud → local). Fallback is opt-in, never silent.
- **Context overflow.** The provider's own rejection is ground truth; the engine compacts the agent's conversation and retries, bounded. (Detailed in the engine's context policy, a later document.)
- **Rate limits.** `rate_limited` is a retryable typed result with the provider's retry hint if present.

---

## 6. Why this matters

The reference implementation's single-model design forces one of two bad outcomes: run everything on a small model (weak on hard roles) or everything on a big model (expensive on mechanical roles). Routing removes the trade-off. Concretely, a typical run's cost is dominated by a few hard calls; routing the summarizers, extractors, and formatters to a local model can cut spend by an order of magnitude at no measurable quality cost — and that is exactly the kind of change the [tuner](tuner.md) should be able to propose and measure.

---

## 7. Acceptance tests (M0/M4)

- `openai-compatible` client: tool-call parsing, usage mapping, and error mapping tested against a fake `fetch`.
- Router: every role resolves to a profile; an unknown profile is a load error.
- Cost math: cached vs uncached input, zero-priced local models, and rounding are unit-tested.
- Alert: a scripted run that crosses its `alerts.costUsd` threshold emits an event and **runs to completion**.
