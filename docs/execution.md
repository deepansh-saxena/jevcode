# Execution and lifecycle

## Permissions and exact actions

Read-only remains the default. `Permissions.commands` enables only named,
configured commands; it does **not** enable arbitrary shell execution.
`Permissions.execution: true` is a separate, explicit opt-in. The model receives
`exec_command` only with that permission, and every invocation, including each
background launch, requires fresh approval of its executable/arguments or shell
text, cwd, timeout, background flag, and isolation backend. Plan mode removes
execution and write permissions. Permission opt-in is not blanket approval.

`exec_command` accepts exactly one of `executable` with optional `args`, or
`shell` (executed by `/bin/sh -c`). `cwd` is workspace-relative, defaults to `.`,
and must be an existing, non-protected directory without symlink or parent
traversal. Explicit relative executable paths are checked against workspace
policy. Configured commands retain their fixed arguments and approval flow.

**Host commands are not sandboxed.** Workspace path checks protect harness file
tools and command cwd; they cannot restrict arbitrary program arguments or shell
code. Approved code can access files elsewhere, contact the network, and use
your OS privileges. Shell edits, capability definitions, hooks and external tools
are not covered by harness file checkpoints. The clean child environment removes
provider credentials and inherited startup variables; `PATH` is retained and
`HOME`/`TMPDIR` point at a fresh private temporary directory, removed afterward.
This is credential hygiene, not a security boundary.

Execution currently fails closed on Windows because the implementation requires
POSIX process-group cleanup. It does not claim to sandbox malicious programs:
programs deliberately escaping their process group and an uncatchable harness
`SIGKILL` are outside its cleanup guarantee.

## Attached tasks

`exec_command` with `background: true` returns an attached task ID immediately
after approval. `task_list`, `task_read`, `task_wait` and `task_stop` inspect,
await or cancel existing work without launching code or asking hidden approvals.
`task_read` includes bounded, live `stdout`, `stderr` and combined `output`.
Final results include `ok`, `exitCode`, terminating `signal`, `truncated`, and an
explicit `error` for timeout, cancellation, spawn or cleanup failure. Nonzero
exit status is observable and never silently treated as success.

The session facade provides the same operations for `/tasks`, `/task <id>`,
`/stop <id>`, `/checkpoints`, and `/undo <id>` via `handleExecutionCommand`.
Inspection and stop remain available after launch permissions are revoked.
Waiting can be cancelled independently of the underlying task.
`shell_output` notifications stream live text, but run logs persist only stream,
task ID and byte count, not raw shell output. A completed turn closes its log;
later attached-job notifications still reach its UI observer without writing to
the closed log descriptor.

Processes use their own POSIX process group **only for cleanup**, not detached
survival: no `unref`, persisted PID files, job recovery, or survive-exit option.
Cancellation/output ceilings/deadlines send TERM, escalate to KILL, and close
pipes. Leader exit also kills ordinary descendants so inherited pipes cannot
keep a job alive. Session close aborts and awaits all tasks; SIGTERM/SIGHUP
handlers close owned sessions when the embedding process has no handler of its
own. Process exit also synchronously kills active local process groups.
Embedders that own signal handling must await `session.close()`.
If an embedding handler is registered after the session, the fallback closes
owned tasks but leaves process termination to that handler so extension cleanup
can finish. Cleanup failures are reported before `run_completed`; pending tool
history and deadline cleanup still finish even when an extension refuses to close.

```ts
const session = new ExecutionSession(project.workspace, project.config);
try {
  await run(project, { ...options, session });
  // Reuse this session across chat turns to retain shell tasks and checkpoints.
  const summaries = session.tasks.list();
  const task = session.tasks.read(summaries[0]!.id);
  await session.tasks.stop(task.id);
} finally {
  await session.close();
}
```

Without an explicit `RunOptions.session`, a run owns an ephemeral session and
closes it before returning. With a supplied session, successful turns may leave
approved shell jobs attached; parent cancellation stops that turn's work.
An execution policy is snapshotted at approval preparation, so changing
configuration during approval cannot silently switch Docker execution to host
execution.

Optional `.jev/config.json` settings (omission uses these defaults):

```json
{
  "execution": {
    "maxJobs": 3,
    "maxTasks": 100,
    "maxOutputBytes": 64000,
    "maxTimeoutMs": 120000,
    "maxParallelSpecialists": 3,
    "isolation": { "backend": "none" }
  }
}
```

Output limits apply to combined stdout/stderr bytes, including decoded invalid
UTF-8. Excess output terminates the command and retains only the bounded prefix.
Shell tasks and foreground commands share the concurrency allowance. Completed
task history is bounded; reaching the history limit requires a new session,
rather than silently evicting unread results.

## Read-only concurrent specialists

`delegate_task` remains sequential by default, with inherited permissions and
ordinary per-action approvals for a mutating specialist. `background: true`
returns a task ID. `delegate_parallel` accepts a `tasks` array of
`{specialistId, task}` and waits for reports in input order, or returns IDs with
`background: true`. Only installed specialists whose entire tool list is drawn
from `list_files`, `read_file`, and `search_files` may run concurrently.
Provider-declared "read-only" external tools do not qualify.

Each specialist has an isolated message context, selected skill instructions,
no nested delegation, no shell, no external tools/hooks, and no approval or
interactive-question channel. Mutating specialists cannot start while concurrent
specialists are running. Reports remain untrusted observations.
All specialists are attached to their **parent run**, not the longer chat:
unfinished specialists are cancelled and awaited before the parent returns.

One run budget covers the main agent, sequential/concurrent specialists, and Jev.
At concurrent launch, the remaining tokens, turns and capped dollars are
partitioned into equal child shares plus a retained parent share (child turn
shares are additionally clamped by specialist limits). Launch validates the
entire batch before starting it. Each request then synchronously reserves
conservative input and maximum-output allowances from its share, and reconciles
reported usage. Unused child capacity returns to the parent only after completion.
Unreported requests retain their reservation and make aggregate cost unknown.
Shared tool-call and specialist-run counters are never multiplied by concurrency.
Conservative allocation may stop a specialist earlier than a sequential run.

`RunOptions.backgroundSpecialists: false` disables concurrent/background
delegation while preserving sequential dynamic delegation.
`dynamicCapabilities: false` removes dynamic delegation entirely.

## Harness-only checkpoints and undo

Successful `write_file`/`replace_text` calls record an automatic per-edit checkpoint:
ID, path, before/after SHA-256, creation time, and a **private in-memory preimage**.
Listing and logs do not expose preimage contents. No snapshot directory is
persisted in `.jev`, and closing the session discards snapshots. Storage is
bounded to 100 edits and 8 MB of preimages; exhaustion blocks further harness
edits explicitly instead of silently dropping undo history.

`list_checkpoints` lists metadata. `undo_edit` requires write permission and
fresh exact-action approval. Undo rechecks the complete current hash both before
approval and at commit, and reuses the normal protected-path, symlink, hard-link,
UTF-8 and size safeguards. It restores the preimage, or removes only a
harness-created file; directories are not recursively deleted. Later edits can
be undone in reverse order, provided each exact after-version still matches.
Subsequent shell/user changes with a different hash cause a conflict, never an
overwrite. Undo does not invoke Git or blanket reset.

The commit protocol briefly captures an existing file in an adjacent private
`.jev-write-*` directory, verifies the captured version, then installs the new
file with an exclusive hard-link operation rather than replacing a file
created concurrently. If another writer creates the target during that window,
the concurrent file is preserved and the captured original remains in the
private staging directory with an explicit manual-recovery error. Ordinary
success/cancellation removes staging files. This is not filesystem isolation
against an adversary racing directory renames or writing through already-open
file descriptors; stop external writers before editing if such races are a
concern. Invalid UTF-8 is rejected rather than taking a lossy preimage.

`session.checkpoints.prepareUndo(id)` prepares an action for trusted UI clients.
The caller must check current write/plan permissions and obtain approval before
executing it; `handleExecutionCommand` performs those checks for slash commands.
There is no shell undo, cross-session recovery, or false claim that checkpoints
capture external side effects.

## Optional Docker isolation

Set `execution.isolation` explicitly:

```json
{
  "backend": "docker",
  "executable": "docker",
  "image": "your-local-image@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}
```

The digest is a placeholder; supply your own trusted, **already available** image
and its real SHA-256 digest. Jev never installs Docker or pulls an image.
`--pull=never` makes an absent image a failure; missing/unusable Docker never
falls back to host execution.

The backend uses network disabled, read-only container root, a 64 MB `/tmp`
tmpfs, all capabilities dropped, `no-new-privileges`, PID/memory/CPU limits, the
calling UID/GID, and a single writable host bind mount of the workspace at
`/workspace`. No host home, credential directory or Docker socket is mounted.
The requested command overrides the image entrypoint. The temporary clean
Docker-client home does not load the user's Docker authentication/configuration.
Non-default remote/context Docker configurations may therefore be unavailable.

**The entire workspace is mounted**, including protected files located inside
it. File-tool protections are not container filesystem filters. An approved
command can change any writable workspace file. Do not put credentials in a
workspace you allow code to execute against.

Each run has a unique container name and explicit `docker rm --force` cleanup,
including cancellation; cleanup has a bounded timeout and reports failure with
the container name for manual inspection. Docker isolation depends on your
Docker engine/kernel/image and is not a guarantee against container exploits.
CI coverage uses a synthetic executable to verify arguments/fail-closed behavior;
it does not require a Docker daemon or download images.

## Reported-dollar budgeting

Prices are unknown by default. No subscription dollar prices are inferred from
catalog data, OAuth access, token counts, or premium-request multipliers.
Supply explicit rates, indexed by **provider/model**, and optional Jev rates:

```json
{
  "spend": {
    "maxUsd": 0.50,
    "models": {
      "openai-compatible/your-model": {
        "inputUsdPerMillion": 1,
        "outputUsdPerMillion": 2
      }
    },
    "jev": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 1
    }
  }
}
```

These numbers illustrate syntax only; they are **not claimed provider prices**.
Use your own reliable rates, including an explicit zero only when justified.
The cap is per run, including its specialists/Jev and preceding automatic
compaction, not a session or account cap. Manual `/compact` has a separate
operation budget. The shared chat/stdio controller accounts each request once.
Model overrides require their own rates. Unknown rates block a request when
`maxUsd` is set; without a cap, unknown/unreported usage keeps `costUsd: null`.
`reportedCostUsd` separately reports the known subtotal, not a complete invoice.
Subscription cache-read/cache-write tokens use the explicit input rate; this is
a configured reported-token estimate, not an assertion about actual billing.

Requests reserve serialized input bytes plus framing allowance (provider-native
context uses a conservative UTF-8 bound), and configured maximum output tokens.
Reservations may stop earlier than actual token usage would require.
Image payload base64 is not counted as text tokens. No verified model-specific
vision token bound is currently available, so capped image requests fail
explicitly before sending, including images retained in conversation history.
Uncapped image requests reserve their scope's entire remaining token allowance
and reconcile actual reported usage afterward; they do not use an invented
fixed image-token cost. The UI's image context-sizing heuristic is separate
from this reservation and does not establish a price or provider token bound.
**This is not a hard provider billing guarantee:** Jev currently has no enforced
output ceiling, tokenizers/framing/provider usage can exceed reservations, and
requests already in flight can report an overshoot. An observed overrun records
actual reported usage, cancels the run and its children, and sends no further
requests. Cancelled or failed requests may still be billed; their usage/cost
remains unknown and their reserved allowance is not recycled.

Embedding UI compaction or other model calls must not bypass the cap:
`RunBudget` in `src/budget.ts` exposes `reserve(source, model, inputUpper,
outputUpper)`, returning `settle(usage)` / `fail()`. Pass the same budget into
`RunOptions.budget` for pre-run compaction. Runtime cost and turn metrics include
that injected budget's whole lifetime; runtime token metrics describe runtime
requests only, so the embedding UI must avoid double-counting pre-run metrics.
Use the exported `reserveModelRequest(budget, model, modelId, messages, tools,
maxOutputTokens)` helper for coding/compaction requests so both text and image
requests follow the same policy and native assistant-history identity is retained.
