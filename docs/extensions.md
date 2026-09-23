# Skills, local plugins, MCP, and hooks

Jev owns discovery, policy, tool approval, and process lifetime. Pi is still used
only for account/provider access. Extensions are not a sandbox: an explicitly
trusted executable can read any file its OS account can read. Never enable
unreviewed commands or servers.

## Skill and specialist catalogs

Project discovery order (first matching ID wins):

1. `.jev/skills/*.json` and `.jev/skills/<name>/SKILL.md`.
2. `.claude/skills/<name>/SKILL.md`.
3. `.claude/commands/<name>.md`.
4. `~/.jev-code/skills/*.json` and `~/.jev-code/skills/<name>/SKILL.md`.
5. Explicitly enabled local plugins.

Specialists use `.jev/specialists/*.{json,md}`, then
`.claude/agents/*.{json,md}`, then `~/.jev-code/agents/*.{json,md}`, then
enabled plugins. IDs must be lower-case letters, digits, and hyphens, starting
with a letter, at most 64 characters. Duplicate IDs **within** a catalog are
errors; project definitions intentionally shadow user definitions.

The existing strict JSON definitions, mandatory skills, `resources`,
`commandIds`, and structured specialists remain supported. JSON instructions
and resources must stay within that catalog, using paths relative to its root
(for example `skills/example.md` in the user catalog). JSON provenance is not
accepted: scope/source/root are derived by the registry, not trusted from disk.
`/skills`, `/skills show ID`, and `/agents` expose this provenance.

```markdown
---
name: release
description: Review and prepare a release
disable-model-invocation: true
user-invocable: true
argument-hint: target-version
---
Prepare release $ARGUMENTS. Inspect references/checklist.md first.
```

Run this explicitly with `/release 1.2.3` or `/skills run release 1.2.3`.
`$ARGUMENTS` inserts the complete argument string. `$ARGUMENTS[0]`, `$0`,
and successive indexes insert zero-based whitespace-separated arguments;
simple single/double-quoted arguments are grouped. Substitution is text-only,
single-pass, never a shell operation. Missing arguments become empty text.
Legacy JSON instructions retain literal dollar syntax unless the definition
opts in with `argumentHint` (an empty string is sufficient).
Pinning through `/skills use ID` also counts as explicit user selection;
argument strings are task-scoped, not persistent.

`disable-model-invocation: true` excludes the skill from Jev routing questions,
model capability listings, model `load_skill`, and automatic specialist
selection involving that skill. Explicit user invocation still works.
`user-invocable: false` removes the slash shortcut and rejects user selection,
but permits model routing/loading. Neither property grants tool permissions.
JSON equivalents are `modelInvocable` and `userInvocable`. Mandatory JSON
skills cannot disable model invocation.

Supported SKILL frontmatter is exactly `name`, `description`, `license`,
`compatibility`, string-valued `metadata`, `disable-model-invocation`,
`user-invocable`, and `argument-hint`. `name` must match the directory.
License/compatibility/metadata are descriptive only. Legacy command Markdown
uses the filename for the name; `description` is optional. Commands still
require frontmatter. Agent Markdown supports `name`, `description`, `tools`,
`skills`, and `maxTurns`; its body becomes the role. Supported Claude tool
names map as follows: `Read` -> `read_file`, `Glob` -> `list_files`,
`Grep` -> `search_files`, `Write` -> `write_file`, `Edit` -> `replace_text`,
`Bash` -> **configured** `run_command`, never unrestricted shell. Absent
agent tools default to the three read-only tools.

Unsupported active fields (`allowed-tools`, `context`, `agent`, `hooks`,
`model`, `permissionMode`, etc.) are rejected, not silently approximated.
Dynamic Markdown shell interpolation such as `` !`command` `` is rejected.
YAML aliases, anchors, explicit tags, duplicate keys, and unsafe keys are
rejected. Arbitrary YAML constructors are never evaluated.

Standard skill resources are listed progressively, not all inserted into the
prompt. The main agent can read a declared resource after loading the skill
using `load_skill_resource`. Scripts are only text: discovery, loading, and
resource access never execute them. JSON resources retain their existing
eager loading and shared skill budget. Specialists receive resources inline
under that same skill budget, without widening their static tool allowlist.
A catalog allows 64 entries; a standard
skill allows 16 resources, depth 4, 64 directories, and 100 KB per text file.
Binary resources fail if read. Hidden credential paths, known credential file
names, symlinks, hard-linked files, and recognizable secret content are rejected.
This is defense in depth, not a guarantee that arbitrary user-authored text
contains no secrets. Keep secrets out of catalogs.

Only named catalog subdirectories in `~/.jev-code` are read; authentication
files are not discovered. Tests and evaluations can call
`loadProject(root, { globalRoot: null })` to disable the user catalog.
`AGENTS.md` and mandatory project policy are unchanged. Ordinary tools cannot
read/write `.jev`, `.jev-code`, or `.claude`.

## Local plugin manifest

Configure local, workspace-relative plugin directories in `.jev/config.json`:

```json
{
  "extensions": {
    "plugins": { "example": ".jev/plugins/example" },
    "mcp": {},
    "hooks": {}
  }
}
```

Each directory contains a strict `jev-plugin.json`:

```json
{
  "version": 1,
  "id": "example",
  "description": "Reviewed local capabilities",
  "skills": "skills",
  "agents": "agents",
  "mcp": {
    "docs": {
      "transport": "stdio",
      "executable": "node",
      "args": ["server.mjs"],
      "env": { "DOCS_TOKEN": "MY_DOCS_TOKEN" },
      "timeoutMs": 30000
    }
  },
  "hooks": {}
}
```

`/plugins list` or `/plugins status` is passive. `/plugins enable example`
validates the manifest/catalogs and requests fresh trust. It adds instructions
and registers, but **does not start**, servers/hooks. Plugin skills cannot be
mandatory. Plugin server/hook IDs are namespaced as `example--docs`.
`/plugins disable example` disconnects its servers and removes its hooks and
capabilities. Plugin manifest changes block new starts/hook executions until
disable/re-enable and fresh approval. Executable contents are not a sandbox or
immutable package: review code and protect the directory from untrusted edits.

No marketplace, remote plugin URL, installer, dependency installation, lifecycle
script, automatic download, or cross-session trust persistence is implemented.
The configured path persists; enablement and executable trust do not.

## MCP

`/permissions external` enables extension controls only after fresh consent.
It is separate from edit permission, fixed-command permission, and
`/permissions all`. It does not trust a server or preapprove any tool call.

Server declarations belong in `extensions.mcp`, or a plugin's `mcp`:

```json
{
  "local": {
    "transport": "stdio",
    "executable": "node",
    "args": ["tools/server.mjs"],
    "env": { "SERVER_TOKEN": "MY_SERVER_TOKEN" },
    "timeoutMs": 30000
  },
  "remote": {
    "transport": "http",
    "url": "https://example.com/mcp",
    "headers": { "Authorization": "MY_MCP_AUTHORIZATION" },
    "timeoutMs": 30000
  }
}
```

Environment/header values are **names of environment variables**, never literal
credentials. `MY_MCP_AUTHORIZATION` would contain the complete authorization
value. Missing references fail. Do not put secrets in executable arguments.
Only `PATH`, `TMPDIR`, `TEMP`, `SystemRoot`, and `LANG` are inherited by
processes; additional variables require explicit named references. In
particular, HOME, provider tokens, NODE_OPTIONS, and the full parent environment
are not implicitly passed. The harness never reads auth files for extensions.

`/mcp list` and `/mcp status` do not contact anything.
`/mcp connect ID` shows the precise config and requests explicit session trust
before starting an unsandboxed process or making a network connection.
Trust covers the protocol handshake, bounded tool discovery, protocol
notifications/ping/cancellation, and teardown, **not** `tools/call`.
`/mcp disconnect ID` closes the transport and removes callable tools. Stateful
HTTP sessions receive a bounded termination request; failed server-side cleanup
is reported explicitly.
Reconnect always requires fresh approval; there is no automatic reconnect.
Concurrent/repeated connection closes share one cleanup result and send at most
one HTTP session termination request. Local transport cleanup is still attempted
if remote termination or SDK cleanup fails.

The Node-20-compatible official MCP SDK is pinned to `1.30.0`. Its Client
and Streamable HTTP transport handle protocol negotiation. Stdio uses the
SDK codec with Jev-owned spawning to enforce exact environment inheritance,
bounded buffering, and process-group teardown. Tool names use the
`mcp__<server>__<digest>` namespace and cannot overwrite built-in tools.
The advertised JSON input schema is also validated locally before approval.
Every external tool call is classified as mutating and requires exact-action
approval. `readOnlyHint`, other annotations, server descriptions, and Jev
recommendations never authorize calls.

MCP tools and hooks are unavailable to specialists, background runs, plan mode,
and ordinary read-only sessions. Moving a host into a non-external run suspends
connections and clears hook trust. Explicit external permission is a separate
capability, so it can be granted without local file-write permission.
Cancellation tears down connections and active hooks and clears executable
trust, including approvals still awaiting an answer. Callable MCP actions are
revoked immediately; cancellation also waits for in-progress startup resources
and disconnects to close. Concurrent cancellations join the same cleanup.
Fresh starts are blocked until cleanup succeeds, then require explicit
reconnect/re-enable approval. Failed MCP cleanup remains an error on subsequent
cleanup attempts; inspect external state and start a new host/session rather than
silently retrying. Exit permanently closes the host; late approval responses
cannot reopen it or install a plugin.

HTTP requires HTTPS, except loopback HTTP for development; credentials, query
strings, fragments, redirects, alternate endpoints, OAuth flows, and automatic
retries are disallowed. The exact configured URL is the only allowed endpoint.
Bodies are streamed through byte limits. Requests/streams use the configured
100 ms–120 s timeout; an expired long-lived notification stream requires
explicit reconnect. Limits are 64 tools, 16 KB input schema per tool,
256 KB total discovery/response or hook output, 64 KB requests/hook input,
and 2.048 MB cumulative stdio output per connection. Oversized output,
EOF, timeouts, and cancellation disconnect; a failed external call may already
have produced effects, so failures explicitly warn against blind retries.

Server stderr is bounded and discarded rather than copied into logs. Sampling,
elicitation, arbitrary resources/prompts, server-driven model calls, and
experimental task APIs are not exposed. On Unix, Jev terminates its owned
process group; on Windows, only the directly owned child process is terminated.
Stdio shutdown allows 300 ms after SIGTERM, escalates to SIGKILL when necessary,
and waits up to another second for the direct child's close event. Failure to
observe that event is reported, not treated as successful cleanup.
Trusted code that deliberately detaches itself is outside this process-lifetime
guarantee.

## Before/after hooks

Hooks are configured separately in `extensions.hooks` (or a plugin):

```json
{
  "check-writes": {
    "event": "before",
    "tools": ["write_file", "replace_text"],
    "executable": "node",
    "args": ["tools/check-write.mjs"],
    "env": {},
    "timeoutMs": 5000
  }
}
```

`/hooks list` is passive. `/hooks enable ID` requires external permission and
fresh unsandboxed-command trust. `/hooks disable ID` revokes it.
Empty `tools` matches every tool; otherwise names match exactly.
Hooks receive one bounded JSON line on stdin:

```json
{"event":"before","tool":"write_file","arguments":{"path":"src/example.ts"}}
```

Arguments are the exact prepared action's review details, not raw model data.
After events additionally include `"completed": true`; they never include
tool results, conversation history, images, or credentials. Recognizable
secret data fails closed instead of being sent. Hook stdout must be empty
(no objection) or a strict `{"deny": true, "reason": "Explanation"}` object.
`deny: false` is also only no objection. No allow/permission/argument-rewrite
fields are accepted. Stderr is never surfaced verbatim.

The runtime obtains exact action approval first, then runs before hooks, then
executes the unchanged action, then runs after hooks. Before-hook denial,
invalid output, nonzero exit, timeout, I/O limit, or cancellation prevents
execution. After-hook failure explicitly reports that the action already
executed and is not rolled back. After hooks run only for actions whose
execution returned successfully. No hook can autoapprove another action.

## Public skills marketplace

Search [skills.sh](https://skills.sh) from chat or an initialized workspace:

```text
/skills search testing
/skills preview OWNER/REPO@SKILL
/skills install OWNER/REPO@SKILL
```

```sh
jevcode skills search testing
jevcode skills preview OWNER/REPO@SKILL
jevcode skills install OWNER/REPO@SKILL --write
```

Use a reference returned by search. Search sends only your query to skills.sh;
do not include private information. Preview/install fetch public GitHub metadata
and raw files without credentials, cookies, telemetry, redirects, subprocesses,
`npx`, Git hooks, or retries. GitHub's anonymous rate limits apply; failures are
reported rather than disguised as empty results. No coding model or Jev call is
needed.

Preview resolves the repository's default branch once to a full commit SHA and
checks each downloaded file against its Git blob hash. Append `#FULL_COMMIT_SHA`
to reuse a specific revision. A preview command does not reserve that revision
for a later install unless you supply the SHA; install always shows the exact
revision and complete files it will write before asking for approval.

Installation needs edit permission outside plan mode and fresh explicit
confirmation. Piped input cannot authorize a standalone CLI installation.
It writes only a new `.jev/skills/NAME/` directory, never overwrites or shadows
an existing skill, and publishes `SKILL.md` after supporting files are written.
New skills become available immediately and survive reload. The private
`.jev-marketplace.json` receipt records source, commit, and file SHA-256 hashes;
`/skills show NAME` includes this provenance. The receipt is an installation
record, not a signature or a guarantee that local files remain unchanged.

Public instructions can influence future agent behavior. Review all content,
the publisher, and the license; install counts are popularity, not trust.
Supporting scripts remain non-executable files and are never run by installation.
Using them later still requires the normal command permissions and approval.
Skills cannot install tools, grant privileges, or bypass protected paths.

The same strict supported frontmatter applies. Symlinks, submodules, binary
resources, protected/credential paths, ambiguous or incomplete repository trees,
nested skills, and case-colliding files are rejected. Limits: 17 files including
`SKILL.md`, four resource-directory levels, 80 KB total downloaded content and
96,000 characters for complete review. Some public skills exceed these limits
or use unsupported frontmatter; Jev rejects them rather than silently stripping
content. Skill lookup uses the marketplace's folder slug (or a matching root
`SKILL.md`), not arbitrary repository-wide script execution.

This integration does not publish skills, install globally, auto-update, remove
existing skills, or discover/install skills on the model's behalf. Updating or
removing a skill remains an explicit local-file maintenance operation.

## Integration API

`new ExtensionHost(project)` owns passive declarations and session-only trust.
`handleExtensionCommand(line, host, io)` returns whether it handled a command.
`io` supplies `confirm`, `write`, `signal`, `permissions`, and context flags.
`confirm(prompt, signal?)` receives a host-scoped abort signal so interactive
prompts can dismiss on cancellation. A late response from an implementation
that ignores the signal is still rejected.
`host.tools(context)` gates MCP tools; the runtime invokes
`beforeTool(action, signal)` / `afterTool(action, result, signal)` only in
foreground, external-enabled main-agent contexts.
`host.cancel()` terminates active resources/revokes executable trust, while
allowing fresh user trust after successful cleanup. `host.close()` also removes plugin capabilities
and permanently closes the host.

`RunOptions.extensions`, `background`, and `skillArguments` are optional.
`loadSkills(project, ids, { source, explicitIds, arguments })` enforces
invocation controls without granting permissions. `skillContent` and
`skillResource` handle catalog provenance without assuming project-relative
paths. Never persist derived provenance as a JSON manifest or inherit an
extension host into a background worker or evaluation.
