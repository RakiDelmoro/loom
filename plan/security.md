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

**Enforced in the agent loop, before the tool runs.** The mode is a second gate, independent of the role's tool grants: a grant says what a role is *for*, the mode says what the run *permits*. A blocked call returns a structured `permission_denied` result and is written to the audit log — the run continues and the model can adapt, rather than crashing or silently succeeding.

The mode outranks an approval: approving a write does not make a read-only run writable.

### 3.3 Approval gates

`permissions.requireApproval` names tools that must be approved before execution. The default is **deny**: a run must be granted the approval explicitly (`loom run --approve run_shell`), so a tool the Blueprint marks as sensitive is never run merely because nobody said no. Denial is a structured result, never an exception.

### 3.4 Sandbox

Command execution runs inside a sandbox — the deployment **container** is the boundary Loom ships with: non-root, restricted egress, a read-only filesystem outside the workspace mount. The sandbox is the **security** boundary; the worktree is the **isolation** boundary, and the two compose.

`bubblewrap` or `gVisor` inside the container would narrow it further; that is a deployment choice, not something the CLI can assume, so Loom does not pretend to enforce a sandbox it cannot verify.

### 3.5 Egress allowlist

Network access is denied by default. `permissions.egress` grants hosts per Blueprint — an exact host, or `*.example.com` — and the one network tool (`fetch_url`) refuses anything else **before opening a connection**. A fetch outside the allowlist is a structured denial, and the request is never attempted.

### 3.6 Secret redaction

Credentials live in the deployment file or environment, never in the Blueprint, never in a prompt. On top of that structural hygiene, **every line written to a run's record passes through a redactor**: the values behind each `apiKeyEnv` are stripped from the manifest and the event log before they are written.

This is not theoretical. A workspace file can contain a credential, a tool result carries it into the transcript, and the log records tool results. The redactor is what stands between that and a leak — and the M7 leak test reads a secret out of the workspace with a real tool call and asserts it never reaches `.loom/`.

### 3.7 Audit

The event stream records every tool call, its arguments, its **full un-truncated result**, and which agent made it, plus every permission denial. A human can reconstruct exactly what ran, what it returned, and what was refused, from `.loom/runs/<id>/events.jsonl` alone.

### 3.8 The HTTP surface

`loom serve` exposes the operator API. Every `/api/` call carries a bearer token from `LOOM_TOKEN`; without it the check is disabled, which is safe only on a loopback bind. The default bind is `127.0.0.1` for exactly that reason.

Static assets are served without a token — a browser cannot present a credential before it has loaded the page, and the page is not the secret. The **data** is.

The API can start, steer, pause, merge, and undo a run. It therefore has the same authority as the CLI on the machine it runs on, and the token is the whole of the boundary. Do not bind it to a public interface without one.

### 3.9 Inspection tools are read-only and bounded

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

- `read-only` mode blocks every mutating tool with a structured denial, and the run continues.
- A denied command never reaches the shell — asserted with a spy on the handler, not by observing output.
- No credential value appears in any file under `.loom/`, **including when a tool reads one out of the workspace**: the leak test reads a secret with a real tool call and asserts the log shows `[redacted]`.
- Every permission denial is written to the audit log.
- `fetch_url` refuses a host outside the allowlist, and the connection is never opened.
- Operator pause / plan-edit / resume is **not** covered here: it needs a control channel, and lands in M8.
