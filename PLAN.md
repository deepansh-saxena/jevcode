# Jev-assisted coding harness

Status: standalone TypeScript harness implemented with Jev routing, standard and
model-authored capabilities, trusted extensions, guarded execution/undo,
plain/full-screen terminals, images, a stdio/VS Code client, and executable coding
evaluation. Codex chat/tool and minimal live Jev routing smoke runs have completed.
Representative held-out evaluation and broader deployment gates remain outstanding.

## Implementation snapshot

The selected foundation is a standalone Node.js/TypeScript CLI, using Pi as an
architectural reference without embedding its agent runtime. Coding-model access
supports OpenAI-compatible Chat Completions and account login for GitHub Copilot
and ChatGPT/Codex through the user-approved Pi authentication/transport library.

Implemented: local configuration and separate skill/specialist registries,
mandatory instruction loading, read/search/edit tools, approval-gated configured
commands, a bounded agent loop, one-level specialists, optional Jev intake routing
with shadow mode, a fail-closed semantic scope-check hook, and metadata event logs.
Account login includes private per-user credential files, token refresh,
status/logout, catalog discovery, and per-run provider/model overrides. Provider
transports still return tool calls to this harness for validation and approval.

Interactive `jevcode` now retains conversation and provider-native history,
streams subscription text, shows tool/routing activity, accepts queued follow-ups,
and supports cancellation and explicit private snapshots/resume. Skills can load
bounded reference resources and name approval-gated configured commands.
New specialist manifests request validated structured reports; legacy text
manifests remain compatible. Jev setup includes hidden key entry, independent
skill/delegation switches, per-user-task routing, and mutation-guardrail shadow
evaluation. Reproducible read-only baseline/Jev trials and labeled scope-check
evaluation are available through CLI commands and development examples.

This is not completion of every release gate below. Host commands and verifier
code are not sandboxed. Optional Docker execution is fail-closed and tested with
a synthetic driver, not a live deployment. Shared request reservations,
configured-rate spend caps, automatic compaction and read-only parallel
specialists are implemented. Held-out calibration, runtime model routing,
metadata caching, broad platform hardening, and demonstrated savings remain
outstanding. Executable coding checks measure the supplied fixtures, not general
coding correctness.

The runtime now prunes older read-only tool output into explicitly marked
excerpts under context pressure. It preserves instructions, native assistant
history, call/result pairs, and mutation outcomes without an extra model call;
this is not semantic summarization. Explicit `/compact` now adds coding-model
summarization with failure-safe retention of the original conversation and usage
accounting. Explicit snapshots separately provide resumable conversation storage.

## Claude-style CLI expansion

The requested direction is an everyday coding CLI with generated reusable
capabilities and discoverable slash commands, while retaining our own runtime
and Jev routing. This is behavioral inspiration, not a claim of compatibility
or a copy of Claude Code's prompts or implementation.

Implemented in this expansion:

- User-directed, coding-model-authored skills and specialists, with complete
  definition review before persistence; no silent self-modifying catalog.
- Same-task skill loading and sequential side-task delegation. New specialists
  cannot delegate recursively, grant permissions, or author further capabilities.
  Shared budgets include a default limit of three specialist runs per user task.
- `/skills` and `/agents` discovery, creation, inspection, pinning, and invocation;
  `/skill-id` shortcuts and Tab completion.
- Live `/permissions`, enforced `/plan` and `--plan`, session model changes,
  `/context`, explicit `/compact`, `/usage`, `/cost`, `/sessions`, `/review`,
  `/config`, `/commands`, `/doctor`, and `/reload`, alongside existing commands.
- Fresh confirmation for permission elevation, restoring privileged tools after
  planning, and replacing unsaved context; queued input never grants approval.

The full CLI expansion also includes:

- Strict supported `SKILL.md`/`.claude` formats and personal catalogs, invocation
  gates, progressive resources, local plugins, MCP stdio/HTTP and opt-in hooks.
- Separate shell/external permissions, attached processes, read-only concurrent
  specialists, shared token/turn/dollar reservations and session-memory undo.
- Optional full-screen input, real images, explicit editor/export/diff, automatic
  compaction, a correlated JSONL protocol and an actual VS Code development client.
- Repeated paired coding fixtures, fixed executable acceptance checks, exact
  initial bug reproduction and a credential-free offline preflight CLI.

Remaining parity work includes marketplace distribution, MCP OAuth/full protocol
support, nested delegation, persistent jobs/undo, broader frontmatter support and
production isolation/platform assurance. These are not placeholder commands.

See [README.md](README.md) for setup, actual behavior, data-sharing implications,
and current limitations. The stages and release gates below remain the roadmap.

## Goal

Build a coding harness that uses a coding LLM for reasoning, code generation,
tool selection, and tool arguments, while using Jev selectively for structured
routing and semantic guardrail judgments.

The hypothesis is that better routing, selective skill loading, and cheaper
semantic checks can reduce cost and end-to-end latency without sacrificing task
success. These gains must be measured against a comparable baseline, not assumed.

## Agreed architecture

- Keep skills and specialists separate. Specialists can reuse skills.
- Let the coding LLM choose tools and generate their arguments. Do not insert Jev
  before every tool call.
- Use Jev at meaningful routing points: selecting relevant skills and deciding
  whether a specialist is worthwhile. Model routing is a later optimization.
- Use Jev for contextual guardrail judgments where model evaluation is needed,
  not as a replacement for deterministic permission checks.
- Keep execution, permissions, budgets, approvals, and failure handling in code.

## Core concepts

| Component | Responsibility | Does not own |
| --- | --- | --- |
| Main agent | Understand the task, reason, use tools, integrate results | Granting itself permissions |
| Skill | Reusable instructions, optional scripts, and reference resources | Its own agent lifecycle or model |
| Specialist | Scoped agent execution with a role, model, context, tools, and budget | Unrestricted access to parent context or permissions |
| Jev router | Make bounded decisions from eligible candidates and task state | Code generation, tool arguments, execution |
| Policy engine | Enforce permissions and turn guardrail signals into allow, deny, or approval outcomes | Treating model confidence as authorization |
| Executor | Validate and run tools, manage processes, report results | Choosing task strategy |
| Session controller | Maintain state, budgets, cancellation, and execution history | Hiding failed or incomplete work |

A skill can be loaded into the main agent without spawning another agent. A
specialist can load several skills. Loading instructions has a context-token
cost, but does not inherently require a separate LLM generation.

Examples:

- `react-conventions`: a skill containing project conventions and references.
- `database-migrations`: a skill describing a migration workflow and scripts.
- `frontend-specialist`: an agent configured with relevant frontend skills.
- `debugging-specialist`: an agent given a bounded failure investigation.

## Execution flow

```text
User task
    |
Session controller + deterministic capability eligibility
    |
Routing checkpoint
    |-- Select relevant skills
    |-- Decide direct execution vs. eligible specialist
    |
Main agent or specialist
    |
LLM proposes a tool call and its arguments
    |
Argument validation + deterministic policy checks
    |
Semantic guardrail checks, only when required
    |
Policy decision: allow / deny / require approval
    |
Execute permitted action
    |
Record outcome, update state, continue or stop
```

Routing happens at task intake and meaningful scope changes, not at every loop
iteration. A blocked action returns an explicit policy result to the agent;
repeated attempts must remain subject to the same policy and run limits.

The controller stops when the task is complete, the user cancels, a budget or
step limit is reached, or progress requires clarification or approval. The final
result distinguishes completed, failed, blocked, and cancelled work.

## Skill and specialist registries

Use local, explicitly trusted manifests. Supported project and personal catalogs
are discovered passively; remote installation and marketplace discovery are not implemented.

| Registry | Minimum metadata |
| --- | --- |
| Skill | Stable ID, version, description, applicability, instruction path, optional resource/script paths |
| Specialist | Stable ID, role, model reference, skill IDs, tool allowlist, input/result contracts, execution budget |
| Tool | Stable ID, description, argument/result schemas, executor, effect classification, permission requirements |

Load skill descriptions first and full instructions only when selected. Preserve
mandatory project instructions regardless of routing, deduplicate loaded skills,
and enforce a context budget. Skill scripts run through the normal executor and
policy checks; a skill is not a permission grant.

Specialists inherit the intersection of session permissions and their configured
allowlist. Their input contains only the task, necessary evidence, constraints,
and expected output. Their result includes status, findings or changes, supporting
evidence, validation performed, and unresolved issues.

Sequential specialists may inherit approved write tools. Concurrent/background
specialists are statically restricted to file list/read/search, with no nested
delegation or interactive approvals. Every specialist has a bounded task,
deadline, and budget drawn from the parent run; cancellation propagates and
unfinished specialists are joined before the run returns. Approved shell jobs
may remain attached across successful chat turns, never across session exit.

## Jev routing

Provide a compact, explicit state: user intent, current phase, relevant project
metadata, loaded skills, eligible capability descriptions, remaining budget, and
recent outcomes. Do not send the entire conversation or repository by default.

Before making external requests, enforce the configured data-sharing policy.
Exclude secrets and send only authorized, necessary content. If redaction removes
information essential to a decision, report insufficient context rather than
treating the sanitized state as complete.

Use separate, atomic questions:

| Decision | Proposed formulation |
| --- | --- |
| Skill relevance | Independent relevance judgments for shortlisted skills; permit multiple skills or none |
| Delegation | Choice among direct execution, eligible specialists, and abstain |
| Model tier, later | Choice among configured models for the selected executor |

Batch questions only when they are independent and use the same state. If model
selection depends on which specialist was chosen, evaluate it afterward or use the
specialist's configured model. A single Choice result must not be treated as a
multi-select skill result.

Validate all returned identifiers against the eligible registry. Apply
compatibility rules, mandatory skills, permissions, and budgets in code.

Choice and Score return probability distributions and a confidence statistic;
Noul returns a value from 0 to 1 without a separate confidence field. Do not treat
confidence as the probability that a decision is correct. Tune per-decision
thresholds on labeled development tasks and evaluate them on held-out tasks.

For uncertain or failed non-security routing, retain mandatory instructions and
use the baseline main-agent path, with the fallback recorded explicitly. Bound
timeouts and retries; do not silently invent a Jev decision.

## Guardrails

### Deterministic enforcement first

Validate tool schemas, workspace boundaries, permissions, network access,
execution limits, and required approvals. Denied actions never reach execution.
Implement filesystem, process, and network isolation where required; shell-string
matching and model judgments are not substitutes for enforceable restrictions.

### Semantic judgments only where useful

Potential questions include whether an action appears outside the requested task
scope or whether retrieved content appears to contain instruction injection.
Treat these as fallible signals. Retrieved text and tool output remain untrusted
data even when no semantic check flags them.

The proposed benefit is replacing an expensive LLM judge on suitable checks, not
adding another mandatory judge to every action. Batch independent checks where
possible. Deterministic policy decides when semantic evaluation is required.

### Approval and failure behavior

- Policy code combines deterministic rules and semantic signals. Jev cannot
  override a hard denial or remove a required approval.
- Required checks finish before execution. Only non-blocking auditing and
  telemetry may run asynchronously.
- Missing context, timeout, unavailable service, invalid output, or uncertain
  required checks block execution pending review or an approved alternate check.
- Approval is bound to the exact action and relevant state. Changed arguments or
  state require revalidation; approvals do not authorize unrestricted retries.
- Initially, do not cache semantic approval decisions. Stale permissions,
  arguments, or workspace state make unsafe cache reuse easy.

## Reference-first development

Use an existing open-source coding harness as the primary reference rather than
inventing every prompt and agent-loop convention. Prefer one coherent starting
point over combining unrelated prompt collections.

Reference choices for the MVP (not security audits):

| Harness | What to investigate | Published license |
| --- | --- | --- |
| [Pi](https://github.com/earendil-works/pi) | Minimal agent loop, skills, prompt composition, extensions, and TypeScript SDK integration | MIT |
| [Codex CLI](https://github.com/openai/codex) | Tool execution, approval/isolation boundaries, context handling, and prompt organization | Apache-2.0 |

Pi's SDK boundaries and prompt composition were inspected. The user selected a
standalone TypeScript implementation compatible with the installed Node 20 runtime,
rather than embedding Pi's current SDK, which requires a newer Node version.
Pi revision `b4588f26af2f74f7b1387b548e04a3c8d81da75b` is recorded as the
architectural reference; no Pi code or prompt text was copied. Codex remains an
unselected secondary reference.

Evaluate three approaches: embed or extend an existing runtime, maintain a small
fork, or implement a thin harness informed by the reference. Prefer extension or
embedding if it exposes all required routing and enforcement boundaries. Keep the
Jev adapter independent of the chosen runtime.

Prompt reuse must be deliberate:

- Inventory the base instructions, tool descriptions, skill-loading instructions,
  delegation/result contracts, and context-compaction prompts actually present.
- Check the license of each reused artifact and preserve required copyright,
  license, attribution, and modification notices. Do not assume every dependency
  or bundled prompt shares the repository's root license.
- Use published, appropriately licensed material, not leaked or extracted private
  system prompts.
- Adapt prompts to the actual model, tool schemas, runtime behavior, and permission
  model. Remove instructions for unavailable features and avoid contradictory
  routing or delegation policies.
- Pin the source revision and record local adaptations. Prompt changes are
  behavioral changes that need evaluation, not just wording edits.

Borrow the execution foundation where useful. The differentiating work is the
separate skill/specialist model, Jev routing, policy integration, and measurement.

## Implementation stages

### 0. Select and map the reference harness

Inspect the candidate's source, licensing, prompt construction, tool loop,
context management, and extension interfaces. Map each required component in this
plan to an existing feature or a necessary addition. Identify which prompts are
portable and which rely on model-specific or runtime-specific behavior.

Exit condition: choose reference-only, extension/embedding, or fork with a pinned
revision, an explicit reuse/license inventory, and confirmed hooks for routing,
pre-execution policy, cancellation, and usage accounting.

### 1. Establish a working baseline

Build or adapt a local CLI with one coding-model adapter, a main-agent loop, a
small tool registry, deterministic policy enforcement, session events, and
explicit error reporting. Start with file reading/search, patch application, and
constrained command execution. Establish budget, deadline, step-limit, and
cancellation paths. Preserve a working baseline before adding Jev.

Exit condition: representative tasks complete end to end, blocked operations
cannot execute, and each run has an attributable cost and timing record.

### 2. Add skills without delegation

Implement manifest validation, mandatory instructions, selective loading, resource
access, deduplication, and context limits. Start with manual or simple deterministic
selection to establish behavior before adding model routing.

Exit condition: the main agent uses skills directly without creating subagents,
and skill scripts cannot bypass the executor or policy.

### 3. Introduce Jev skill routing

Add a provider adapter with typed request/response validation, deadlines, bounded
retries, and observable fallback. Run routing in shadow mode first: record what
Jev would select without changing execution. Then enable routing behind a switch.

Exit condition: multiple-skill and no-skill cases work, mandatory skills remain
loaded, and held-out results justify enabling the router.

### 4. Add scoped specialists and delegation routing

Implement specialist manifests, isolated conversation contexts, permission
intersection, shared budget accounting, result contracts, and lifecycle handling.
Add Jev's direct-versus-specialist decision with direct execution as a valid path.

Exit condition: a bounded specialist task returns a usable result, cancellation
works, and neither recursive delegation nor conflicting workspace writes occurs.

### 5. Evaluate Jev semantic guardrails

Define a small set of contextual checks and labeled allowed, blocked, ambiguous,
and adversarial cases. Compare Jev with any existing LLM judge in shadow mode,
without treating shadow results as permission to execute.

Exit condition: policy and approval paths remain enforced, outage cases fail
closed for required checks, and false-allow/false-block results are documented.

### 6. Optimize only demonstrated bottlenecks

Evaluate model routing, safe metadata caching, and independent read-only parallel
specialists separately. Keep only optimizations that improve measured outcomes.
Do not change several routing policies at once and then attribute the gain to Jev.

## Measurement and release criteria

Use fixed task definitions and starting workspace snapshots, repeated runs,
identical available tools and skills, comparable limits, and recorded model,
prompt, skill, and policy versions. Separate development tasks for threshold
tuning from held-out evaluation tasks. Randomize run order where practical.

Compare:

1. The baseline harness without Jev, retaining all required safety controls.
2. The same harness with Jev routing enabled.
3. The same harness with an LLM semantic judge versus Jev for equivalent checks,
   if a semantic judge is part of the intended workflow.

Use feature switches to evaluate skill selection, delegation, and guardrail
replacement individually before testing their combination.

| Metric | What to record |
| --- | --- |
| Task success | Acceptance checks, including correctness and scope compliance |
| Cost per successful task | Total evaluation spend, including failed runs and retries, divided by successful tasks |
| End-to-end latency | Median and p95 across attempted tasks, with failures/timeouts reported separately |
| Human wait | Approval and clarification time, separate from machine execution time |
| Routing overhead | Jev requests, elapsed time, failures, abstentions, and fallback rate |
| Context efficiency | Input/output tokens, skill tokens loaded, duplicated specialist context |
| Delegation usefulness | Completion rate, handoff overhead, rework, and specialist calls avoided |
| Guardrail behavior | False allows, false blocks, escalations, and deterministic enforcement failures |

Release only when held-out results demonstrate a meaningful improvement in cost
or latency without an unacceptable regression in the other metric or task
success. Set numeric tolerances and the evaluation sample size before the measured
comparison, once the workload and baseline are known. Report uncertainty; do not
claim a win from a small noisy difference.

Require zero observed deterministic-policy bypasses in the enforcement tests.
Measure semantic guardrail error rates separately; passing a finite test set is
not proof of security. Do not replace an existing judge solely because Jev is
faster if the required guardrail quality is not met.

All events should include stable run/action IDs, decision outcomes, durations,
usage where available, fallback reasons, and policy versions. Avoid logging
credentials or raw sensitive task content. Label unavailable pricing or usage
data as unknown, not zero.

## Scope boundaries and open decisions

Not in the initial scope: Jev-based tool selection, autonomous agent swarms,
recursive delegation, remote skill marketplaces, multi-user hosting, or a GUI.

Resolved for the MVP: standalone TypeScript on Node 20, Pi's agent runtime as a
reference, Pi's provider library for Copilot/ChatGPT account access,
OpenAI-compatible Chat Completions, and a direct Jev HTTP adapter. Initial skills
are coding/testing, with a read-only investigator specialist. Mutations require
per-action approval; Jev data sharing is opt-in.

Resolve before broader deployment:

- OS-level execution isolation and enforceable network permissions.
- Representative evaluation tasks and comparison tolerances.
- Workload-specific budgets and a dollar-spend policy.
- Data-sharing approval and log-retention settings for the intended environment.
- Required semantic checks, calibrated thresholds, and acceptable error rates.

## References

- [Jev introduction](https://docs.typesafe.ai/introduction): typed questions and independent evaluations.
- [Jev with coding agents](https://docs.typesafe.ai/introduction/coding-agents): Jev is a decision component, not a coding LLM.
- [Confidence](https://docs.typesafe.ai/confidence): probability distributions, confidence, and uncertainty handling.
- [Pi coding agent](https://github.com/earendil-works/pi/tree/main/packages/coding-agent): documented skills, extensions, and SDK entry points.
- [Pi license](https://github.com/earendil-works/pi/blob/main/LICENSE): MIT reuse terms.
- [Codex CLI](https://github.com/openai/codex): secondary open-source harness reference; inspect source before adapting its patterns.
- [Codex license](https://github.com/openai/codex/blob/main/LICENSE): Apache-2.0 reuse terms.
