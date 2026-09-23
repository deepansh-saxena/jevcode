# Executable coding evaluation

`benchmark` remains a **read-only routing probe** with literal answer checks.
`benchmark-code` measures actual edits against fixed executable acceptance checks.
Neither proves general coding quality or that Jev improves a particular model.

## Run a coding comparison

Review `examples/coding-benchmark.json` first. It contains three self-contained
fixtures: a cart quantity fix, a retry-boundary fix with a new regression test,
and a cross-module discount/shipping investigation. Their initial implementations
fail specific assertions; their unrelated behavior is also checked.

Configure the coding model and Jev in the current project's `.jev/config.json`,
including explicit Jev data-sharing consent, then run:

```sh
npm run build
node dist/cli.js benchmark-code examples/coding-benchmark.json --allow-verifier-code
```

For offline fixture validation without project configuration, model credentials,
Jev, or provider calls:

```sh
jevcode benchmark-code examples/coding-benchmark.json --allow-verifier-code --preflight
```

Preflight prints each exact initial check outcome. Invalid reproduction/comparison
reports exit with status 1; cancellation exits with status 130.

**Trust warning:** verification executes suite-authored and model-written
JavaScript with your OS permissions. A temporary directory, a separate process,
and `node:vm` are **not a security sandbox**. The flag is mandatory even for
bundled examples. Only execute suites and generated code you trust; use a
separately secured machine/container for untrusted adversarial code. A malicious
VM escape can defeat the in-process restrictions. Immutable container mounts or
a stronger verifier backend are not implemented here.

There is no dependency installation, shell command, or network access exposed
to fixture code by the verifier. Each verifier process starts with an empty
environment in its own named temporary directory. It gets a bounded JSON source
snapshot, not the user's workspace, credentials, HOME, or project commands.
Normal model and Jev calls still use configured providers and may incur charges.
The benchmark never starts a live run as part of offline tests.

The harness preflights every task before spending any model tokens. It requires
**exactly the declared assertion failures**, with all other checks passing.
Syntax errors, missing modules, output overflow, process crashes, and timeouts
are invalid fixtures, not successful bug reproduction. Invalid tasks are
reported and skipped, and the overall comparison is marked invalid.

## Comparison policy

Each task/repetition gets a baseline and Jev trial. Both start with the same
fixture tree, model, output/turn/tool/token/time budgets, instructions, available
skills and specialists, and write permissions. A seeded Fisher-Yates shuffle
randomizes trial order; fresh workspace and conversation state prevent edits
from carrying between arms. The seed controls ordering, **not model randomness**.

The suite, not the user's workspace or global catalog, supplies capabilities.
No project source, AGENTS.md, skill resources, secret files, or credential files
are copied. Specialist model overrides and commands are forbidden.
`feature` selects `skills`, `delegation`, or both (`routing`). Only automatic
Jev routing differs between arms. Semantic guardrails are off in both arms;
guardrail evaluation remains a separate command.

`dynamicCapabilities: "off"` disables model-driven capability discovery,
loading, creation, and delegation in both arms. `"identical"` enables the same
runtime discovery/loading/delegation tools in both arms under the feature
flags. Background specialist work is disabled; delegation is sequential.
Capability creation is never approved. Report this policy with results:
a dynamic-off baseline cannot choose optional skills for itself.

Only `write_file` and `replace_text` against exact `writablePaths` receive
automated approval, and only inside this dedicated fixture harness. Commands,
shell execution, external extensions, and capability persistence are disabled.
The ordinary CLI `run`/chat approval behavior is unchanged.

## Suite contract

The JSON schema is exported as `codingBenchmarkSchema` from
`src/coding-evaluation.ts`. Version 1 supports synchronous CommonJS JavaScript:

| Field | Meaning |
|---|---|
| `split` | `development` or `heldout`; a label, not a leakage guarantee |
| `repetitions`, `seed` | Paired repeat count and deterministic trial ordering |
| `files` | Explicit initial relative-path-to-source map per task |
| `writablePaths` | Exact files the agent may create or edit |
| `requiredChangedPaths` | Nonempty files that must actually change |
| `checks` | Fixed external `{id, code}` acceptance programs |
| `expectedInitialFailures` | Exact check IDs that must initially fail assertions |
| `capabilities` | Inline skills and specialists shared by both arms |
| `verifier` | Process deadline and combined stdout/stderr byte limit |

Acceptance code can `require('./relative-file.cjs')` from the source snapshot
(explicit extensions required) and `require('node:assert/strict')`. The
assertion interface exposes `equal`, `deepEqual`, `ok`, and `throws`. Fixture
modules can import only other relative fixture modules, not Node built-ins.
Each check gets fresh module state. Async checks are unsupported; a returned
promise is an error. Tests should use synchronous assertions and primitive
values (strict deep equality across separate VM realms can reject prototypes).

Acceptance programs never live inside the writable fixture tree and cannot be
changed through agent tools. A full tree snapshot checks forbidden changes and
required changed-file presence before verification. Agent-authored tests are
**not** the acceptance oracle: the retry example's fixed checks execute the
new test against correct and original buggy implementations and verify that it
asserts the requested boundary inputs. This is limited mutation testing, not a
proof that the generated test exhaustively covers the feature.

Avoid vacuous acceptance programs. Preflight catches checks that always pass,
but suite authors must still review what each assertion measures. Keep held-out
tasks private when making generalization claims. Do not tune on those tasks
and then describe them as unseen.

## Interpret the report

A trial is accepted only if the runtime completed, all changed-file constraints
hold, and **every fixed check passes**. Final-answer wording and tool counts
cannot turn wrong code into a pass. Failed/blocked/limited/cancelled runs remain
failures even if they happened to write a passing patch.

The report includes initial/final tree hashes, suite/config/capability hashes,
runtime policy version, actual routes, errors, fallback counts, token usage,
per-check results, and paired outcomes. Jev outages/fallbacks remain visible;
their patches may pass acceptance, but the comparison is not valid evidence
about functioning Jev routing. A Jev arm with no routing request is also invalid.

`machineMs` is full trial wall time including setup, agent execution, verification,
and cleanup, minus `approvalWaitMs`. Automated fixture approval is **not human
approval latency**. Runtime metrics separately expose agent duration and usage;
`jevMs` records router latency. Initial preflight verification is separate.
Cancellation returns a partial report with incomplete pairs and invalid comparison.
Verifier stdout/stderr and time are bounded. The child has a 64 MiB V8
old-space limit, **not a hard process-memory quota**; named temporary roots are
cleaned after completion or cancellation.

Token totals are **observed** usage; incomplete provider usage is counted.
With explicit `spend` rates and complete reported usage, `costUsd` sums every
trial's configured-rate cost, including failed trials; `costPerAcceptedTaskUsd`
divides that total by the accepted count. With missing rates/usage, both stay
`null` (unknown), not zero. `reportedCostUsd` is only the known subtotal. Zero
accepted tasks have no cost-per-accepted value. Subscription or unpriced routing
usage must not be presented as measured dollar savings.
Compare paired acceptance first, then latency and usage; small public toy
fixtures and a few repeats are not statistically reliable superiority claims.

For offline runner coverage:

```sh
npx tsx --test test/coding-evaluation.test.ts test/evaluation.test.ts
npm run check
```

These tests use scripted coding models and loopback Jev responses. They exercise
real file edits and executable acceptance, not live credentials or API credits.

For preflight alone, the exported
`preflightCodingBenchmark(suite, signal, {allowVerifierCode: true})` API requires
no project, model, credentials, or Jev server. It returns per-task executable
results and a `valid` boolean. This verifies the committed bug-before state;
it is not a substitute for running both coding arms.
