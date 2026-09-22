# Jev Code

A standalone TypeScript coding harness with GitHub Copilot account login,
ChatGPT/Codex account login, or an OpenAI-compatible API key, plus optional Jev
routing. Skills are reusable instructions; specialists are separate, bounded
agent executions that reuse those skills.

This is a local MVP, not a sandbox or a demonstrated cost/latency improvement.
The coding LLM selects tools. Jev does not sit in front of every tool selection.

## Quick start

Requires Node.js 20.20 or newer.

```sh
npm ci --ignore-scripts
npm run build
npm link --ignore-scripts
jevcode init
jevcode inspect
```

`npm link` installs the `jevcode` terminal command for your current Node/npm
installation. Run `jevcode` to start an interactive chat, or `jevcode --help`
to see commands. Noninteractive bare invocation still prints help.
The older `jev-code` spelling remains an alias. The link points to this checkout:
keep it in place and run `npm run build` after source changes. If you switch Node
versions with nvm, run `npm link --ignore-scripts` again for the selected version.

`init` creates `.jev/` in the target workspace and refuses to overwrite an existing
directory. If it is already initialized, skip `init`. Choose account login:

```sh
jevcode login copilot
# Or:
jevcode login openai
```

Complete the displayed browser/device-code flow in your own terminal. A successful
login selects that provider and a default model in this workspace. Alternatively,
leave `llm.provider` as `openai-compatible`, configure your base URL/model, and set
`OPENAI_API_KEY` in your environment. Do not put credentials in project files,
prompts, or chat messages.

```sh
jevcode
# Or allow approval-gated edits and configured commands:
jevcode --write --commands
# One-shot/scriptable mode remains available:
jevcode run "Explain this project's architecture"
jevcode run --skill testing "Identify missing regression tests"
jevcode run --specialist investigator "Investigate the failing test"
jevcode run --write "Add a regression test for the reported bug"
jevcode run --write --commands "Fix the bug and run the configured tests"
```

Runs are read-only by default. `--write` exposes editing tools; `--commands`
exposes configured commands. **Each write or command still requires an interactive
`yes` approval.** Noninteractive runs cannot approve mutations and return a
nonzero exit code when approval is needed. There is no blanket auto-approve flag.

Use `--cwd /absolute/path/to/project` with `init`, `inspect`, `login`, or `run` to
select another workspace. That workspace needs its own `.jev/` configuration.
Account credentials, status, and logout are per-user, not per-workspace.
`npm run dev -- ...` runs the same CLI directly from TypeScript.

The API-key adapter uses `POST /chat/completions`, function tools,
`max_completion_tokens`, and non-streamed responses with token usage. The default
model is `gpt-4.1-mini`; change it to a model supported by your provider. An
"OpenAI-compatible" endpoint must support these fields. HTTPS is required except
for loopback development servers. No credentials or live cloud calls are needed
to run the local automated tests.

## Interactive chat

Run `jevcode` (or `jevcode chat`) in an initialized workspace. Provider, model,
skill, specialist, write, and command flags work as in `run`. Chat shows routing,
tool activity, and subscription-provider text as it arrives; the API-key adapter
prints text after each complete response rather than streaming tokens.
Follow-up prompts reuse the main agent's messages and provider-native history.
Jev routes once per new user task, never once per tool call.

Ctrl-C cancels the active turn and returns to the prompt; Ctrl-C at an idle prompt
exits. Messages typed while a turn runs are queued. They do not interrupt a tool
or act as approvals: approval requires a new `yes` at the exact-action prompt.
Use Ctrl-C to stop current work before sending a correction that must take effect
immediately. This is a line-oriented terminal UI, not a full-screen editor.

| Chat command | Behavior |
| --- | --- |
| `/help`, `/status` | Show commands or current settings |
| `/clear` | Start fresh context without changing workspace files |
| `/jev off`, `/jev shadow`, `/jev on` | Change routing for this chat only; prior sharing consent is required |
| `/save` | Ask before writing a private snapshot; prints its resume UUID |
| `/resume UUID` | Load a saved snapshot for this workspace/provider/model |
| `/exit`, `/quit` | Leave the chat |

`jevcode --resume UUID` resumes at startup. Saving is opt-in: snapshots contain
raw conversations, accessed file contents, and native model history, but no
adapter credentials. They are **unencrypted**, stored under `.jev/sessions/`
with private directories (0700) and files (0600) on macOS/Linux, and are not
included in metadata logs. Delete specific snapshots when no longer needed.
Windows ACL protection is not implemented. Resume preserves observations, not
approvals: current instructions, configuration, permissions, and file hashes
remain authoritative. Missing results from cancelled/blocked batches are marked
as unknown rather than rerun. Shared turn/token/time limits reset per user task;
the bounded conversation survives until `/clear` or exit.

## Account login and provider selection

| CLI name | Config provider | Authentication and default model |
| --- | --- | --- |
| `copilot` | `github-copilot` | GitHub device login; `gpt-4.1` |
| `openai` | `openai-codex` | ChatGPT/Codex browser login; `gpt-5.5` |
| `api` | `openai-compatible` | Environment API key; initially `gpt-4.1-mini` |

**`login openai` uses ChatGPT/Codex subscription access, not OpenAI Platform API
billing.** An eligible account, available usage allowance, and applicable
organization permissions are required. Copilot likewise requires Copilot access.
Logging in does not grant access to every catalog model. `models` lists the
adapter's bundled catalog, not live account availability; it can include retired
or unavailable models.

```sh
jevcode auth status
jevcode models copilot
jevcode models openai
jevcode login openai --model gpt-5.5
jevcode run --provider copilot --model gpt-4.1 "Explain this project"
jevcode run --provider openai "Investigate this bug"
jevcode run --provider api --model gpt-4.1-mini "Explain the tests"
jevcode logout copilot
jevcode logout openai
```

`login` persists the selected provider/model only after authentication succeeds.
`run --provider` and `--model` are one-run overrides; switching providers without
`--model` uses the new provider's default. To select an already-authenticated
provider permanently without another login, edit `llm.provider` and `llm.model`.
Old configs without `llm.provider` remain in API-key mode. Missing account
credentials never silently fall back to an API key.

If an older workspace still selects `gpt-5.4-mini` and Codex rejects it, try
`jevcode run --provider openai --model gpt-5.5 "Explain this project"`.
To keep that selection, change `llm.model` in `.jev/config.json` to `gpt-5.5`;
updating the CLI does not overwrite existing model choices. Model availability
and allowance consumption depend on your account. Unsupported-model errors now
name the selected model and include the HTTP status when available, without
exposing raw provider responses or credentials.

These are community-maintained integrations from `@earendil-works/pi-ai`, not
official Copilot/Codex agent runtimes. Only authentication and model transport are
reused. Jev Code still owns the agent loop, tool validation, approvals, skills, and
specialist budgets. Native model history, including opaque reasoning signatures,
stays in memory for tool continuations and is included in context-size accounting,
not persisted in metadata logs. Explicit `/save` snapshots include this history.

The pinned Pi Copilot login requests enabling its catalog models, including
third-party models, on your account. The CLI requires explicit confirmation
before starting that flow; organization policy may still deny access. OpenAI
login uses a loopback callback on port 1455 and supports pasting the full callback
URL as a fallback. Paste input is hidden. Login has a ten-minute deadline and
Ctrl-C terminates its isolated authentication worker.

For Copilot, type `yes` and press Enter at `Continue? [yes/no]`. At the GitHub
Enterprise domain question, press Enter without typing anything for a normal
github.com account. The CLI then displays the device login URL and code.

### Credential storage

Credentials are stored in private files under `~/.jev-code/auth/`, separate from
the project and separate from any existing Copilot/Codex/Pi CLI login. Directories
use mode `0700`, files use `0600` on macOS/Linux. Tokens are **not encrypted at
rest**; this is not an OS keychain integration. Keep your home directory and
backups protected. Windows ACL hardening is not implemented or validated.

Access tokens refresh automatically when needed. A per-provider lock prevents
concurrent login, refresh, and logout from overwriting rotated credentials.
Writes are atomic; failed refreshes preserve the previous credentials and
surface an error. If a process is forcibly killed, a `.lock` directory can remain:
remove only that provider's stale lock after confirming no authentication process
is running.

`auth status` reports presence and expiry without tokens. `logout` removes Jev
Code's local credentials only: it does not revoke the provider grant, undo model
policy choices, or log out other apps. Revoke grants through the provider's
account settings if needed.

File tools block `.jev-code`, even when a workspace includes your home directory.
Approved commands remain unsandboxed and can access your files, including stored
credentials. Account adapters do not send tokens to `llm.baseUrl`; that setting
applies only to API-key mode. Use the packaged model catalog for account models,
including specialist model overrides.

## Workspace configuration

```text
.jev/
  config.json
  skills/
    coding.json
    coding.md
    testing.json
    testing.md
  specialists/
    investigator.json
  runs/
    <run-id>.jsonl
  sessions/
    <snapshot-id>.json
```

The generated config includes all defaults and is validated strictly: unknown
fields and invalid settings fail explicitly. Model API keys are read from the
environment variable named by `llm.apiKeyEnv` or `jev.apiKeyEnv`.

`AGENTS.md` at the workspace root is loaded as mandatory project guidance.
No parent-directory instructions, external extensions, or remote skills are
automatically discovered. Nested `AGENTS.md` auto-loading is not implemented.

### Skills

A skill manifest points to an instruction file under `.jev/skills/`:

```json
{
  "id": "testing",
  "version": "1",
  "description": "Design regression tests and investigate test failures.",
  "instructions": ".jev/skills/testing.md",
  "mandatory": false
}
```

Mandatory skills are always loaded. Optional skills can be chosen by `--skill`
(repeatable) or by Jev. Only selected instruction bodies enter the coding-model
context. Jev routing receives descriptions, not the skill bodies. Skills are
deduplicated and subject to a combined character budget; overflowing it is an
explicit error rather than silently dropping mandatory instructions.

Optional `applicability` text supplies additional routing criteria. A `resources`
array lists trusted reference files under `.jev/skills/`; their contents load
only with the selected skill and count against the same instruction budget.
`commandIds` references existing configured commands as skill scripts; it does
not execute them, enable command tools, or bypass per-action approval. Arbitrary
script paths and remote skill installation are not supported.

### Specialists

A specialist manifest defines an isolated conversation and a narrower tool set:

```json
{
  "id": "investigator",
  "description": "Read-only investigation of a concrete bug or failing test.",
  "role": "Investigate without editing. Return evidence, suggested fixes, and unknowns.",
  "skills": ["testing"],
  "tools": ["list_files", "read_file", "search_files"],
  "maxTurns": 5,
  "maxToolCalls": 10,
  "resultFormat": "structured"
}
```

An optional `model` field overrides the coding-model name for that specialist,
using the same configured provider. Specialist tools are intersected with the
session's enabled tools. A manifest cannot grant write or command permissions.

At most one specialist runs per user task, followed by the main agent. The specialist
gets the task, selected skills, and up to three previous user task texts on
follow-ups, not the main agent's tool results or assistant history.
Its report is passed to the main agent as untrusted observations. Newly generated
specialists use `resultFormat: "structured"`: a validated JSON object with
`summary`, `findings` (objects with `finding` and `evidence` strings), `changes`,
`checks`, and `unresolved` arrays. Evidence is reported, not independently proven.
Malformed reports produce an explicit limited handoff for direct investigation.
Older manifests without this field retain freeform text behavior. There is no
recursive delegation or concurrent workspace editing.
Specialist-local limits return an explicitly partial report; global limits stop
the entire run.

## Jev routing and guardrails

Jev is **off in newly initialized workspaces**. Set it up without putting a key
in shell history or chat:

```sh
jevcode jev setup
jevcode jev status
jevcode
```

Setup asks for sharing consent and `on`/`shadow`, uses an existing environment
key or a hidden replacement-key prompt, and makes a small connection-test request.
With explicit approval it stores the key in private
`~/.jev-code/jev-key.json` (unencrypted, separate from OAuth credentials).
`TYPESAFE_API_KEY` takes precedence. `jevcode jev logout` removes only the stored
key; `jevcode jev off` disables routing without weakening required guardrails.
The same private-file limitations as OAuth credentials apply.

Setup confirmation accepts `y` or `yes` (case-insensitive); executing writes and
commands still requires the full word `yes`. Paste only the API key from
[TypeSafe's key dashboard](https://console.typesafe.ai/keys), without quotes or
an `Authorization`/`Bearer` prefix. Surrounding whitespace is trimmed; the adapter
adds the required Bearer scheme itself.

If you encountered HTTP 403 with an earlier build, rebuild and rerun setup: the
old adapter omitted the Bearer scheme. Failed connection tests do not save the
entered key or change workspace settings. HTTP 401 indicates a rejected key;
a remaining 403 indicates denied access and requires checking the account/API
permissions, endpoint, or model with TypeSafe. Setup identifies whether it is
using an environment key, saved key, or newly entered key, without displaying it.
Update or unset a rejected `TYPESAFE_API_KEY` environment value; use
`jevcode jev logout` before replacing a rejected saved key.

Alternatively, edit these fields inside the
existing `jev` object in `.jev/config.json`:

```json
{
  "mode": "shadow",
  "allowDataSharing": true
}
```

Set `TYPESAFE_API_KEY` in the environment or complete setup. `shadow` records the suggested skills
and specialist but runs the explicit/manual baseline. Set `mode` to `on` only
when you want Jev's choices to affect execution. Explicit `--skill` and
`--specialist` choices are preserved in every mode.

The router batches independent skill-relevance questions and a delegation choice
into one intake request. Mandatory skills are not optional candidates. Low
delegation confidence or abstention keeps execution with the main agent. Invalid
answers, missing credentials, HTTP failures, and timeouts produce a visible
`routing_fallback` event and retain mandatory/explicit skills and manual choices.
Jev and the API-key adapter do not automatically retry requests. Optional
`routeSkills: false` or `routeSpecialists: false` disables that decision
independently for controlled comparisons. Follow-up routing includes up to three
prior user task texts (not tool results or assistant history) plus current
permissions. Ineligible specialists are excluded before asking Jev.

Routing and semantic guardrails are independent switches. To require a semantic
scope check for writes and commands, set:

```json
{
  "guardrail": "mutations",
  "allowDataSharing": true
}
```

`guardrail: "all"` checks every proposed tool action, including reads, and can add
substantial latency. `off` disables semantic checks. Required checks run before
approval and execution; unavailable, malformed, or uncertain results block the
action. A passing Jev check never overrides path restrictions or human approval.
The initial check evaluates task scope only, not general prompt-injection safety.
`guardrail: "shadow"` evaluates mutation scope and records would-allow outcomes
or outages without acting as a required check. Deterministic restrictions and
human approvals still apply. Never use shadow mode to replace an existing
required guardrail.

The default thresholds (`skillThreshold`, `delegationConfidence`, and
`guardrailThreshold`) are provisional configuration values, **not calibrated
security or quality guarantees**. Jev Choice confidence is a distribution
statistic, not a probability that the decision is correct.

### Data sharing

The coding provider receives the task, loaded instructions, model conversation,
and accessed tool results. Jev routing receives the task, candidate descriptions,
selected capability IDs, configured limits, permissions, and up to three previous
user task texts in chat. A semantic check receives the
task and full proposed action, which can include new file contents or replacement
text. Enable it only when those inputs are authorized for the external service.

A size cap and heuristic prefilter block obvious secret patterns before Jev
requests. This is **not comprehensive secret detection or data-loss prevention**.
The harness does not silently redact incomplete context and then approve an
action. Use only workspaces and content permitted for the configured providers.

## Tools and enforcement boundaries

| Tool | Behavior |
| --- | --- |
| `list_files` | Bounded recursive listing of accessible workspace files |
| `read_file` | Numbered text, truncation metadata, and full-file SHA-256 |
| `search_files` | Bounded literal text search with explicit skipped-file reports |
| `write_file` | Approved new-file creation or whole-file replacement with expected hash |
| `replace_text` | Approved replacement of exactly one occurrence with expected hash |
| `run_command` | Approved execution of a fixed command ID from configuration |

File tools reject absolute paths, parent traversal, symlinks, and hard-linked
files. Built-in protected paths include `.jev`, `.jev-code`, `.git`, `.env*`, common credential
files/directories, and `node_modules`; `protectedPaths` adds file/directory prefixes.
The agent cannot edit `AGENTS.md` through file tools.

Edits recheck the expected file version after approval, write via a temporary
file, and publish the replacement atomically. New files cannot overwrite an
existing file. These checks protect ordinary local workflows; they are not an
OS-enforced boundary against hostile concurrent filesystem changes.

**Commands are privileged and not sandboxed.** No arbitrary shell strings or
model-supplied command arguments are accepted, but a configured `npm test` can
execute arbitrary project scripts with your OS permissions, access other paths,
or use the network. Review the exact command and project before approval. A small
environment allowlist avoids forwarding provider keys, but cannot prevent a
command from reading credentials elsewhere on the machine. Use an external
container/VM when isolation is required.

Commands have bounded output and deadlines. On macOS/Linux the harness terminates
the spawned process group on cancellation/exit; deliberately detached descendants
are not an enforceable containment boundary. Windows descendant cleanup is not
implemented or validated.

## Limits, events, and results

Each run shares turn, tool-call, reported-token, context-size, and wall-clock
limits across the main agent, specialist, and Jev requests. Ctrl-C cancels active
work. Approval waiting counts toward the wall-clock deadline and is also measured
separately.

When context exceeds 75% of `maxContextChars`, the harness shortens older
read-only results toward a 50% target, retaining small excerpts and file hashes.
The newest batch stays intact unless it alone cannot fit with the retained
history. Shortened results explicitly mark `contextPruned` and `truncated`;
missing content must be reread with targeted line ranges if needed. System and
user instructions, assistant/native reasoning history, call/result pairs,
mutation/command outcomes, and errors are not pruned. This is deterministic
excerpting, not an LLM-generated summary, and adds no model requests.
`context_pruned` events contain only sizes and counts, never file contents.
The hard limit still applies if the retained context cannot fit.

Token limits are checked after each response, so they can overshoot by one
in-flight request. `maxOutputTokens` is forwarded where the provider supports it;
the pinned Codex subscription adapter does not enforce this output-token cap.
Shared reported-token, context, turn, and deadline limits still apply. There is
no hard dollar-spend cap.

Subscription transports can have internal retries (the pinned Codex transport can
retry up to three times) within the request deadline, even though Jev Code disables
retries where the library honors that option. Metrics count harness-level requests,
not every hidden transport attempt. Failed attempts may incur unreported usage:
`usageIncompleteRequests` flags harness requests whose usage is unknown.
`costUsd` is `null`; subscription allowances and premium requests are not mapped
to API dollar pricing. No billing or quota tracker is implemented.

```sh
jevcode run --json "Explain the test setup"
```

JSON results include status, final text, effective route, timings, known usage,
run ID, and event-log path. Status is one of `completed`, `failed`, `blocked`,
`cancelled`, or `limited`. `completed` means the agent returned a final answer,
not independent proof that its changes are correct. Inspect its stated checks
and run project acceptance tests.

Metadata-only JSONL logs are written under `.jev/runs/` with restrictive file
permissions. Events include routing outcomes, scores, model/tool calls, approvals,
usage, config/prompt hashes, skill versions, and completion status. They do not
persist task bodies, file contents, tool arguments/results, or final answers.
Error messages can include file paths. Logs have no automatic retention policy;
delete specific old log files according to your requirements.

Semantic context summarization and runtime model routing are not implemented.
Read-only output pruning is explicit and bounded; irreducible context still stops
at the configured limit rather than silently dropping instructions or mutation
outcomes. The terminal remains line-oriented, not a full-screen coding IDE.

## Reproducible evaluation

```sh
jevcode benchmark examples/benchmark.json > benchmark-results.json
jevcode evaluate-guardrails examples/guardrails.json > guardrail-results.json
```

These commands make real coding/Jev requests and consume account allowance.
They require Jev sharing consent and a key. The included suites are tiny
**development examples**, not release evidence or calibrated security tests.

Benchmark suites specify a `split` (`development` or `heldout`), independent
`feature` (`skills`, `delegation`, or `routing`), repeat count, random seed, and
tasks with embedded fixture files. Each trial runs in a fresh temporary workspace
with the same config, registries, instructions, and read-only tools. The seeded
order mixes baseline and Jev trials. Required guardrails are kept identical.
No commands or writes are approved; this runner evaluates read-only tasks.
Fixture directories are removed afterward; source workspace files are untouched.

Acceptance uses case-sensitive `answerIncludes`, `answerExcludes`, and
`minToolCalls` plus completed status. These checks are not a substitute for human
review or executable correctness tests on coding tasks. Results retain failures,
fallbacks, incomplete-usage flags, per-trial tokens and timings, median/p95
latency, and config/suite/registry hashes without raw tasks or answers.
`validRoutingComparison` is false if a Jev trial fell back instead of routing.
Costs and cost per accepted task remain `null` when pricing is unknown.

Guardrail suites specify labeled `allow`/`block` cases with `task` and `action`.
The evaluator uses exactly the live scope question without executing actions,
reports false allows/blocks and outage counts separately, and applies the
configured threshold without tuning it. Use development tasks for tuning and a
separate held-out suite for evaluation. Set workload, sample size, quality
tolerances, and acceptable guardrail error rates before a measured comparison.
No optimization or threshold is automatically promoted from these results.

## Development

```sh
npm run check
npm test
npm run build
```

Tests exercise the execution loop and CLI with local mock HTTP providers, plus
file policy, approvals, specialists, routing fallback, semantic guardrail failure,
budgets, and cancellation. Auth tests cover private storage, refresh, worker
cancellation, and subscription tool round trips with synthetic credentials and
offline/local mock providers. On macOS, real-terminal approval and offline login
tests use the system Python 3 standard library when available. Live Copilot,
ChatGPT/Codex, OpenAI-compatible, and Jev interoperability still requires an
authorized credentialed smoke run. No cost or latency savings have been established.

## Reference and provenance

Architecture was informed by Pi's SDK boundaries and compositional system-prompt
construction, inspected at revision
[`b4588f26af2f74f7b1387b548e04a3c8d81da75b`](https://github.com/earendil-works/pi/tree/b4588f26af2f74f7b1387b548e04a3c8d81da75b).
The harness does not embed or fork Pi's coding-agent runtime. Its orchestration
and prompts are original. Account authentication/model transports use the
MIT-licensed `@earendil-works/pi-ai@0.74.0`, pinned for Node 20 compatibility;
current newer releases require Node 22.19 or newer. The catalog and authentication
protocols may need updates as providers change. Dependencies retain their own
package licenses. The official Codex agent runtime is not embedded.

The Jev adapter follows the published
[HTTP API](https://docs.typesafe.ai/api), including the Bearer API-key Authorization
header and typed Noul/Choice answers. See [PLAN.md](PLAN.md) for the longer-term
architecture and evaluation gates.
