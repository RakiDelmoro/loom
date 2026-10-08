# Blueprint Format

The Blueprint is the entire behavior of the system as data: roles, their prompts, their tool grants, their model routing, the run's budgets and permission mode. It is the artifact the [tuner](tuner.md) rewrites.

Two files, deliberately separate:

| File | Holds | Who writes it |
|---|---|---|
| `loom.json` (**the Blueprint**) | roles, prompts, tools, routing **profile names**, budgets, permissions | the tuner |
| `loom.deployment.json` (**deployment**) | provider endpoints, credentials, model ids, prices | the operator |

The tuner must never be able to leak a credential into the artifact it optimizes, and a run must be reproducible across deployments. Hence the split.

---

## 1. Top level

```jsonc
{
  "entryRole": "orchestrator",
  "roles": { /* role name → definition */ },
  "tools": ["tools/read_file.json", "tools/write_file.json", "..."],
  "routing": { /* profile name → model binding */ },
  "budgets": { /* run-wide ceilings */ },
  "permissions": { /* capability mode */ },
  "visualization": { /* optional display metadata */ }
}
```

Validated strictly: **unknown keys are rejected at every level**, so a typo fails loudly instead of silently changing behavior. Every error carries a JSON path (`roles.coder.tools[2]`).

---

## 2. Roles

```jsonc
"roles": {
  "coder": {
    "prompt": "prompts/coder.md",
    "model": "worker",
    "tools": ["read_file", "write_file", "list_dir", "run_shell", "git_status", "git_diff", "finish"],
    "isolation": "worktree",
    "parallel": { "maxChildren": 1 },
    "label": { "detailed": "Coder", "friendly": "Coder", "whimsical": "Builder" }
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `prompt` | yes | Path to a Markdown system prompt, relative to the Blueprint file. |
| `model` | yes | A routing **profile name**. Never a concrete model id. |
| `tools` | yes | Tool names this role may call. A role sees only these. |
| `isolation` | no (default `worktree`) | `worktree` (own branch and tree) or `shared` (**the caller's tree**, for read-only roles). |
| `parallel` | no | `maxChildren` — how many `agent` children this role may run at once. Default 1. |
| `styleGuide` | no | Path to a shared style file appended to the prompt at load time. |
| `label` / `description` / `workingLabel` | no | Display metadata in three tiers (`detailed`, `friendly`, `whimsical`) for the UI. |

**Tool grants are the capability model.** The engine exposes only the role's declared tools; a call to an undeclared tool is a typed `unknown_tool` error, not a crash. Reviewer roles are granted **no mutating tools** by construction — a reviewer cannot "fix" its way past a problem it should report.

**Workflows are not declared.** There is no graph. A workflow is a role calling `agent` on other roles and combining results before `finish`.

---

## 3. Tools

```jsonc
{
  "name": "read_file",
  "description": "Read a file from the workspace.",
  "parameters": {
    "type": "object",
    "properties": { "path": { "type": "string" } },
    "required": ["path"]
  }
}
```

Manifests declare `name`, `description`, and JSON-Schema `parameters`. The manifest is what the model is shown; the role's `tools` grant is what the engine enforces before dispatch, and a call outside it is refused with `unknown_tool`. Built-in tools are listed like any other; the engine provides their implementation.

**Built-ins (engine-implemented):** `agent`, `finish`, `read_file`, `write_file`, `list_dir`, `glob`, `search`, `run_shell`, `git_status`, `git_diff`, `git_log`, `fetch_url`.

The `agent` manifest's description is extended at run time with the Blueprint's role names, so a model chooses a role that exists instead of inventing one — a guess comes back `role_not_found` and costs a turn.

---

## 4. Routing

```jsonc
"routing": {
  "reasoner":   { "provider": "together", "model": "deepseek-ai/DeepSeek-V4.1-Flash", "temperature": 0.2 },
  "worker":     { "provider": "together", "model": "deepseek-ai/DeepSeek-V4-Flash-0731", "temperature": 0.1 },
  "summarizer": { "provider": "local",    "model": "qwen3-4b",                        "temperature": 0.0 }
}
```

The Blueprint names **profiles**; the deployment resolves a profile to an endpoint, credentials, and price. A run may override a role's profile (`--model-override coder=reasoner`) without editing the Blueprint. Details: [model-routing.md](model-routing.md).

---

## 5. Budgets, alerts, and permissions

```jsonc
"budgets": {
  "maxAgentDepth": 6,
  "maxConcurrentAgents": 8,
  "toolTimeoutSeconds": 60
},
"alerts": {
  "costUsd": 5.0,
  "tokens": 2000000
},
"permissions": {
  "mode": "workspace-write",
  "requireApproval": ["run_shell"]
}
```

`budgets` holds limits the engine **enforces**. `alerts` holds thresholds it merely **reports** on — the split is the schema telling the truth about what each field does.

| Field | Meaning |
|---|---|
| `budgets.maxAgentDepth` | Recursion ceiling; an `agent` call beyond it is refused with `depth_exceeded`. |
| `budgets.maxConcurrentAgents` | How many model calls may be in flight at once. |
| `budgets.toolTimeoutSeconds` | Default per-tool timeout; a call may request less, never more. |
| `alerts.costUsd` | Optional. Crossing it emits an event. **The run is not stopped.** |
| `alerts.tokens` | Optional. Crossing it emits an event. **The run is not stopped.** |
| `permissions.mode` | `read-only` \| `workspace-write` \| `full`. Enforced before any mutating tool runs. |
| `permissions.requireApproval` | Tool names that must be approved before execution. |

Spend is measured and recorded, never enforced — see [model-routing.md](model-routing.md) "Spend visibility, not enforcement" for why.

Details: [security.md](security.md).

---

## 6. Visualization (optional)

Display-only metadata so a swapped Blueprint re-flavors the UI with no frontend change: `pseudoRoleLabels`, `operationTemplates`, `genericOperationTemplates`, `workingTemplates`. The engine ignores it entirely.

---

## 7. A complete example

```jsonc
{
  "entryRole": "orchestrator",
  "roles": {
    "orchestrator": { "prompt": "prompts/orchestrator.md", "model": "reasoner", "tools": ["agent", "finish"], "parallel": { "maxChildren": 3 } },
    "planner":      { "prompt": "prompts/planner.md",      "model": "reasoner", "tools": ["read_file", "list_dir", "search", "finish"], "isolation": "shared" },
    "coder":        { "prompt": "prompts/coder.md",        "model": "worker",   "tools": ["read_file", "write_file", "list_dir", "glob", "search", "run_shell", "git_status", "git_diff", "finish"] },
    "reviewer":     { "prompt": "prompts/reviewer.md",     "model": "reasoner", "tools": ["read_file", "list_dir", "search", "git_diff", "finish"], "isolation": "shared" },
    "recovery":     { "prompt": "prompts/recovery.md",     "model": "reasoner", "tools": ["agent", "finish"] }
  },
  "tools": ["tools/read_file.json", "tools/write_file.json", "tools/list_dir.json", "tools/glob.json", "tools/search.json", "tools/run_shell.json", "tools/git_status.json", "tools/git_diff.json", "tools/finish.json", "tools/agent.json"],
  "routing": {
    "reasoner": { "provider": "together", "model": "deepseek-ai/DeepSeek-V4.1-Flash", "temperature": 0.2 },
    "worker":   { "provider": "together", "model": "deepseek-ai/DeepSeek-V4-Flash-0731", "temperature": 0.1 }
  },
  "budgets": { "maxAgentDepth": 6, "maxConcurrentAgents": 8, "toolTimeoutSeconds": 60 },
  "permissions": { "mode": "workspace-write" }
}
```

Note the reviewer: read-only tools, `shared` isolation, no `write_file`. That is the capability model doing its job.

---

## 8. Validation rules

- Every `prompt` path exists and is non-empty.
- Every `tools[]` entry names a declared tool; every declared tool has a valid manifest and a unique name.
- Every role's `model` names a declared routing profile.
- `entryRole` names a declared role.
- No unknown keys, at any depth.
- Numeric budgets are positive; `permissions.mode` is one of the three strings.

Validation runs at load and again on every tuner branch, so an invalid Blueprint is rejected before it can run.
