# Security

## 1. Threat model

Loom runs a language model with file, shell, and git access against a project. The trust split:

- **The model is trusted** — it carries out the operator's intent; it is not assumed to emit attacks.
- **The workspace is untrusted** — it may contain malicious scripts, binaries, package manifests, or prompt-injection payloads that try to override the system prompt, ignore safety rules, or exfiltrate data.

The goal is to prevent untrusted workspace content from coercing the trusted model, and to contain any damage to the run's worktree.

Unlike the reference implementation, which states the model is trusted and enforces that with a container boundary alone, Loom enforces it **structurally** in the engine as well: capability modes, approval gates, and a sandbox are part of the design, not an afterthought.

---

## 2. Attack surface

- **Model-generated shell commands.** `run_shell` and the git tools execute what the model chooses. A confused model can run destructive commands by mistake — the same risk as any local coding agent.
- **Prompt injection.** A task or a file can attempt to override prompts or exfiltrate data. This is the primary path by which untrusted content reaches the trusted model.
- **Network egress.** A subverted model could read files and send them to a remote host.
- **File traversal.** Path tools must not escape the worktree.
- **Supply-chain inputs.** Workspace scripts, binaries, and manifests are untrusted.

---

## 3. Mitigations

### 3.1 Isolation is already the first defense

Each agent runs in its own worktree. A destructive command damages that worktree, not the base tree and not a sibling. This is not a security boundary by itself — a worktree shares the host filesystem — but it confines accidental damage and makes every change reviewable before it merges.

### 3.2 Permission modes

Set per run on the Blueprint; enforced by the engine **before** a mutating tool executes.

| Mode | Allows |
|---|---|
| `read-only` | Read tools only. No writes, no shell, no commit. |
| `workspace-write` | Writes confined to the agent's worktree; `run_shell` allowed; no network egress unless allowlisted. |
| `full` | Unrestricted within the sandbox. |

A blocked call returns a structured `permission_denied` result — the run continues and the model can adapt, rather than crashing.

### 3.3 Approval gates

`permissions.requireApproval` names tools that must be approved before execution (`run_shell`, or commit/push). In interactive mode the operator approves; in batch mode a policy decides (allowlist of command prefixes, or deny-by-default). Denial is a structured result, never an exception.

### 3.4 Sandbox

Command execution runs inside a sandbox — `bubblewrap` (cheap, Linux, no daemon), `gVisor` (stronger, needs a runtime), or a container. The sandbox is the **security** boundary; the worktree is the **isolation** boundary. The two compose: a sandboxed shell inside an agent's worktree is the strongest configuration.

Sandbox properties: no network by default, read-only access outside the worktree, a scoped `PATH`/`HOME`, dropped capabilities, a non-root user, and a hard CPU/memory/time cap.

### 3.5 Egress allowlist

Network access is denied by default. An allowlist (registries, documentation hosts) is opt-in per Blueprint. A fetch outside the allowlist is a structured denial.

### 3.6 Secret redaction

Credentials live in the deployment file or environment, never in the Blueprint, never in a prompt. Every transcript, event, and log line passes through a redactor that strips known secret values before writing. A leak test (M7) asserts that no credential value ever appears in `.loom/`.

### 3.7 Audit

The event stream records every tool call, its arguments, its outcome, and which agent made it. A human can reconstruct exactly what ran, and why, from `.loom/runs/<id>/events.jsonl` alone.

### 3.8 Inspection tools are read-only and bounded

Overseer roles get windowed, capped, read-only access to another agent's conversation — never full messages. A compromised overseer cannot flood its own context with a target's 256k-token history, and has no write path into another agent's history.

---

## 4. What the design does not prevent

- A deliberately destructive task given by a legitimate operator. Loom contains execution to the worktree; it does not second-guess the user.
- A model that destructively modifies files inside its own worktree. That is expected for coding tasks; isolation prevents damage elsewhere, and git makes it reversible.
- A model acting maliciously. The model is trusted; defending against it is a different threat model.
- Resource exhaustion within the configured budgets.

---

## 5. Tuner implications

The [tuner](tuner.md) can propose edits that add tools or broaden grants. Every candidate is validated against a **promotion contract** before evaluation:

- It may not weaken the permission mode.
- It may not add a tool that escapes path confinement or the sandbox.
- It may not touch the deployment file, credentials, or the bench.

A candidate that loosens a safety invariant is rejected before it runs. Reviewing tuner reports must include checking which tools were added or removed and whether prompt changes make the model more susceptible to coercion.

---

## 6. Acceptance tests (M7)

- `read-only` mode blocks every mutating tool with `permission_denied`; the run continues.
- A denied command never reaches the shell — asserted by a spy on the subprocess leaf, not by observing output.
- No credential value appears in any file under `.loom/` (leak test over a run that uses a credentialed provider).
- A path traversal attempt (`../../etc/passwd`) is rejected with a typed error.
- A network call outside the allowlist is denied.
