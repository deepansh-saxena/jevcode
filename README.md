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
installation. Run `jevcode` to see help, or `jevcode <command>` from any directory.
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
not persisted in logs.

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
  "maxToolCalls": 10
}
```

An optional `model` field overrides the coding-model name for that specialist,
using the same configured provider. Specialist tools are intersected with the
session's enabled tools. A manifest cannot grant write or command permissions.

At most one specialist runs at intake, followed by the main agent. The specialist
gets the task and selected skills, not the main agent's conversation history.
Its report is passed to the main agent as untrusted observations. Reports are
freeform text inside a harness-owned status envelope, not a validated structured
findings schema. There is no recursive delegation or concurrent workspace editing.
Specialist-local limits return an explicitly partial report; global limits stop
the entire run.

## Jev routing and guardrails

Jev is **off by default**. To evaluate routing, edit these fields inside the
existing `jev` object in `.jev/config.json`:

```json
{
  "mode": "shadow",
  "allowDataSharing": true
}
```

Set `TYPESAFE_API_KEY` in the environment. `shadow` records the suggested skills
and specialist but runs the explicit/manual baseline. Set `mode` to `on` only
when you want Jev's choices to affect execution. Explicit `--skill` and
`--specialist` choices are preserved in every mode.

The router batches independent skill-relevance questions and a delegation choice
into one intake request. Mandatory skills are not optional candidates. Low
delegation confidence or abstention keeps execution with the main agent. Invalid
answers, missing credentials, HTTP failures, and timeouts produce a visible
`routing_fallback` event and retain mandatory/explicit skills and manual choices.
Jev and the API-key adapter do not automatically retry requests.

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

The default thresholds (`skillThreshold`, `delegationConfidence`, and
`guardrailThreshold`) are provisional configuration values, **not calibrated
security or quality guarantees**. Jev Choice confidence is a distribution
statistic, not a probability that the decision is correct.

### Data sharing

The coding provider receives the task, loaded instructions, model conversation,
and accessed tool results. Jev routing receives the task, candidate descriptions,
selected capability IDs, and configured limits. A semantic check receives the
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

The MVP has no transcript persistence, resume, streaming UI, automatic context
compaction, runtime model routing, or benchmark runner. It stops explicitly at
context limits instead of silently summarizing or discarding evidence.

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
[HTTP API](https://docs.typesafe.ai/api), including the raw API-key Authorization
header and typed Noul/Choice answers. See [PLAN.md](PLAN.md) for the longer-term
architecture and evaluation gates.
