# Terminal, images, sessions, and editor integration

Jev Code is a local Node 20 CLI. Provider calls require your configured coding
provider credentials. Jev routing is separately opt-in; none of these interfaces
enable it automatically.

## Terminal modes

`jevcode` or `jevcode chat` starts the deterministic line-oriented interface.
`--plain` explicitly selects it, including under a PTY. Scripts should use
`jevcode run "task"` or the stdio protocol below; interactive chat requires a TTY.

`jevcode --fullscreen` opts into a full-screen transcript, activity/status line,
command completion menu, and multiline input editor. It uses Blessed for terminal
rendering, resize handling, and alternate-screen management. Enter inserts a
newline; **Ctrl-S submits**. Left/right/up/down, Home/End, Backspace/Delete, and
Ctrl-U edit input. Tab completes a unique slash command or shows matching commands.
PgUp/PgDn and mouse scrolling move through the bounded transcript. The visual
transcript retains its last 120,000 characters, not the whole in-memory model
conversation. The interface is deliberately small, not a claim of pixel-for-pixel
Claude CLI parity. Very narrow terminals and grapheme-cluster cursor positioning
are not fully optimized.

In plain mode, `/paste` collects multiple lines until a line containing exactly
`/end`. Ordinary Enter submits one line. Tab uses readline completion.

Ctrl-C cancels the active turn (including approvals and questions), or exits at
the idle prompt. Exit, cancellation, terminal close, SIGHUP, and SIGTERM restore
terminal state. Provider/tool text is rendered as inert text: ANSI, OSC, and
directional-control injection is escaped. Full-screen action-review prompts over
100,000 characters are refused rather than silently truncated.

Input submitted while busy is queued, with a 20-message limit. **Queued input
never answers a confirmation or clarification.** Each confirmation starts with a
fresh input buffer; pretyped partial `yes` is discarded. In plain mode type `yes`
and Enter; in full-screen mode type `yes` and Ctrl-S. Enter alone never approves
anything in the full-screen interface. Model `ask_user` answers do not grant tool
permissions or approve actions.

## Real image attachments

In chat, `/attach images/screenshot.png` reads an image from the workspace and
asks permission to send that exact in-memory image to the current coding provider
with the next task. `/detach` discards pending images. Switching models, clearing,
or resuming context also discards pending attachments.

For one-shot use:

```sh
jevcode run --image images/screenshot.png "Explain the error shown here"
```

Providing `--image` explicitly consents to provider sharing. Chat's startup
`--image` options still present individual attachment confirmations.

Files must be workspace-relative, allowed by workspace policy, regular and
non-linked. Parent traversal, symlinks, hard links, credentials/protected paths,
and non-image files are refused. PNG, JPEG, GIF, and WebP extensions must match
their binary signatures. Each image is limited to 2,000,000 bytes, with at most
four per task. Signature checks do not replace a provider's image decoder.

Account adapters check the bundled Pi model's image-input capability. API mode
conservatively accepts known image-capable GPT-4o, GPT-4.1, GPT-4-turbo, GPT-5,
o1/o3/o4 model IDs and supported dated variants; custom/text-only/unknown IDs are
refused. A compatible endpoint still must implement those models' multimodal
formats. Images become genuine OpenAI `image_url` or Pi `image` content blocks;
there is no text-description fallback.

Image bytes are excluded from Jev routing metadata and event logs. Provider
requests and explicit private snapshots contain them. Context accounting reserves
16,384 estimated characters per image instead of counting base64 bytes; actual
image token usage is provider-specific and reported after requests. Snapshot
size remains capped at 8 MB, so large image conversations may not be saveable
without compaction.

That character estimate is not a vision-token price or guaranteed upper bound.
Uncapped image requests reserve the remaining token allowance and reconcile
reported usage. With `spend.maxUsd`, image-bearing requests (including historical
images or compaction) are blocked because no verified provider vision-token
upper bound is available.

## Explicit session and file operations

`/name NAME` labels future snapshots without saving anything. `/save [NAME]`
requires confirmation and creates a new private, unencrypted snapshot; it never
overwrites an existing snapshot. `/sessions` lists IDs, optional names, dates, and
sizes, not transcripts. `/resume UUID` restores only into the same workspace,
provider, and model. `/continue` or `jevcode --continue` loads the newest explicitly
saved snapshot; this is **not** implicit autosave. A latest snapshot from a
different model is refused; choose a matching snapshot with `/resume`.

`/export relative/new-file.txt` previews the privacy warning and requires
confirmation before creating a mode-0600 file. Existing files, protected paths,
and symlinks are refused. Exports contain user/assistant text, including any
historical summaries, but omit tool/system messages and image bytes. They can
still contain private source code. Nothing is written when confirmation is denied.

`/diff` shows bounded tracked git changes against HEAD, including staged and
unstaged changes. It does not run configured commands, external diff tools, text
converters, or fsmonitor. Protected/unsafe paths are omitted explicitly. Untracked
files and shell changes not represented in git's tracked diff are not included.
It requires a repository with HEAD and does not modify the index or working tree.

`/compact [FOCUS]` summarizes model history and accounts its token usage.
`/auto-compact on` requires consent to model usage; `--auto-compact` is explicit
startup opt-in. Before subsequent tasks, context at 65% of the character budget
triggers semantic compaction. Compaction keeps current trusted instructions, the
latest user task and its images, and a clearly untrusted historical summary.
It does not carry approvals forward. Older image observations may be summarized;
reread source evidence before editing. Failed, oversized, tool-calling, or
non-shrinking summaries leave original context intact and visibly stop that turn.
Compaction is never persisted automatically. Automatic compaction and the following
run share token, turn and configured-dollar reservations; usage is counted once.
Manual `/compact` gets its own operation budget. Unknown rates or insufficient
remaining allowance block the request before it reaches the provider.

Both terminal modes and `serve` share one execution session and extension host.
`/tasks`, `/task ID`, `/stop ID`, `/checkpoints`, and `/undo ID` work across turns.
`/permissions execution` is a separate approved opt-in; `/permissions all` never
grants arbitrary shell or external permissions. Entering plan mode or revoking
execution stops attached shell jobs. Plan mode and read-only review revoke
extension connections/hook trust; later use needs fresh trust. Undo requires a
new exact-action approval and refuses files changed since the recorded edit.

## External editor

`/editor` uses only explicitly configured `JEV_EDITOR`, an **absolute executable
path**, with optional `JEV_EDITOR_ARGS`, a JSON array. No shell parsing or expansion
occurs; `EDITOR` and `VISUAL` are not executed implicitly.

```sh
export JEV_EDITOR=/usr/bin/vi
# For a VS Code executable, also use:
export JEV_EDITOR_ARGS='["--wait"]'
```

The editor receives a new mode-0600 prompt file in a private temporary directory.
Terminal ownership is suspended until the process returns successfully. Jev reads
at most 48,000 bytes, displays the prompt, and asks fresh confirmation before
submitting it. Empty/failed/cancelled editors never submit. The temporary file is
removed afterward. Choose an editor you trust: it runs with your OS access and
environment, and that editor may maintain its own backups.

## Version 1 local stdio protocol

`jevcode serve [--cwd DIR] [--provider ...] [--model ...] [--plan]` reads one JSON
request per newline and writes only newline-delimited JSON to stdout. It never
opens a network listener. stderr is reserved for startup errors. The process
retains one in-memory conversation, initially read-only unless explicit CLI tool
flags are passed. Startup emits:

```json
{"type":"ready","protocol":"jevcode","version":1,"maxLineBytes":65536,"capabilities":["prompt","commands","approval","question","cancel","status"],"persistence":"explicit-save-only"}
```

Request examples:

```json
{"id":"turn-1","method":"prompt","params":{"text":"Explain this project"}}
{"id":"status-1","method":"status"}
{"id":"cancel-1","method":"cancel","params":{"runId":"turn-1"}}
```

`prompt` also accepts slash commands, including `/attach`, `/save`, `/permissions`,
and `/exit`. `/editor` is terminal-only; IDEs supply their own prompt editor.
There is at most one active prompt; new prompts while busy return an error rather
than becoming implicit approvals. Each nonempty request ID must be unique within
the process. The session accepts at most 10,000 IDs. Input lines are bounded at
65,536 bytes, prompt text at 48,000 characters, and clarification answers at 12,000.
Oversized/malformed lines are rejected without echoing their contents.

Events have `{type:"event",event,runId,data}`. `text` events contain `data.text`;
other events report routing, tools, usage, run state, and compaction. `runId` is
the prompt request ID (distinct from an event log's UUID). Completion returns
`{type:"response",id,result}`; failures outside a run return
`{type:"response",id,error}`. Runtime results distinguish completed, blocked,
cancelled, failed, and limited runs. Clients must inspect status, not just the
presence of a result.

An approval event contains a newly issued UUID and the exact request to display:

```json
{"type":"event","event":"approval_request","runId":"turn-1","data":{"requestId":"ISSUED-UUID","details":{"prompt":"Exact action and details..."}}}
{"id":"decision-1","method":"approve","params":{"runId":"turn-1","requestId":"ISSUED-UUID","approved":false}}
```

Clients must show the full exact-action prompt and obtain a new human decision.
They must never manufacture, cache, queue, or automatically grant approvals.
Both IDs and the interaction kind must match the currently pending request.
Forged, wrong-run, duplicate, stale, replayed, or post-cancellation approvals are
rejected. `approved` must be a JSON boolean, not `"yes"` or another truthy value.

Model clarification uses `event:"question"` with
`data:{requestId,details:{question,choices?}}`; reply with
`{id,method:"answer",params:{runId,requestId,answer}}`.
Approval responses cannot answer questions and vice versa. Cancelling the active
run resolves pending interactions without granting permission. EOF aborts work
and closes session services. `/exit` closes the protocol session. Clients must
drain output; more than 2 MB of queued output causes cancellation.

Image paths are provided through `/attach`, not arbitrary base64 protocol fields.
Credential environment variables are read locally by the child CLI, never included
in protocol configuration or messages. All clients are trusted local processes;
the protocol is not an authentication boundary and should not be exposed over a
socket or forwarded to untrusted callers.

## VS Code client

`editors/vscode/` contains a real, dependency-free extension-host client. It is not
published to the marketplace. Build the CLI with `npm run build`, then launch an
extension development host:

```sh
code --extensionDevelopmentPath=/absolute/path/to/jev-code/editors/vscode /your/workspace
```

Configure **user-level** `jevcode.executable` as an absolute executable, and
optionally `jevcode.arguments`. For example, use your absolute Node executable
with `["/absolute/path/to/jev-code/dist/cli.js"]`, or an installed `jevcode`
executable with no arguments. These are machine-scoped settings, not workspace
commands. Authentication/configuration uses the same local CLI stores; the
extension does not copy tokens into the webview.

Run **Jev Code: Open Local Chat**. The in-memory webview supports multiline prompts,
Cancel, and a `/tasks` shortcut when execution lifecycle services are integrated.
Slash commands provide attachments, permissions, diff, export, and sessions.
**Send Selection** requires an explicit command and task; selected text is sent
only then. The extension requires workspace trust and uses no shell, network
listener, command URIs, external resources, rendered Markdown HTML, or persisted
webview state. A nonce CSP and `textContent` render provider text inertly.
Every approval is a fresh modal decision showing the exact request; closing the
dialog denies it. Clarification can be answered or dismissed to cancel the turn.
Closing the panel terminates the child session; reopening starts fresh.

The client is intentionally basic: one active workspace session, a bounded
transcript, and no inline code lens/diff application or marketplace installer.
Protocol and client transports have offline tests; interactive extension-host
packaging and platform-specific editor behavior still need manual user validation.
