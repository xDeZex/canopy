# Compiled execution and TypeScript migration

## Build boundary

`tsc` emits a disposable mirror: `server/`, `public/` and `test/` become
`dist/server/`, `dist/public/` and `dist/test/`. Each build deletes all old
output first, then copies non-code assets in those three trees. The server's
relative public-directory lookup and native browser `.js` imports are unchanged.
The executable is `dist/server/index.js`; npm packages include only the compiled
server/public trees (plus normal package metadata and README).

`tsconfig.json`'s **explicit `files` array is the migration manifest**, not a
broad include glob. The baseline had 94 JavaScript inputs. Issue #68 replaced
the routing helper and its unit test (2 TS / 92 JS); issue #69 also migrates
the HTTP app, request handler and their three test files: **7 strict TS inputs
and 87 remaining JS inputs**. Issue #70 then migrates four discovery/commit/deletion
modules and five further test files (the HTTP integration test overlaps #69),
and adds three narrow port/test helpers: **19 TS / 78 JS inputs**.
Issue #75 migrates 17 browser helpers/controllers, their 17 test files and the
shared DOM helper, and adds two narrow port/type modules: **56 strict TS inputs
and 43 remaining JS inputs**.
Issue #72 migrates the five durable-comment modules and their three test files:
**64 strict TS inputs and 35 remaining JS inputs**.
Issue #71 migrates the three file-tree/comparison/rename modules and their three
test files. Combined with #72, the manifest contains **70 strict TS inputs and
29 remaining JS inputs** (99 total). The original #71 branch had 62 TS / 37 JS;
its historical evidence below is separate from these integrated counts.
Issue #76 migrates the workspace/live-update owners and their two direct test
files, and adds their validated JSON/IO contracts. Combined with #71 and #72,
the manifest contains **75 strict TS inputs and 25 remaining JS inputs** (100
total). The original #76 branch had 61 TS / 39 JS; its historical evidence below
is separate from these integrated counts.
Issue #77 migrates the two viewer/editor lifecycle owners and their four
conversation-flow test files, adding two consumed-capability ports and one
test helper after removing the obsolete legacy workspace wrapper. Combined with
#71, #72 and #76, the manifest contains **84 strict TS / 19 remaining JS inputs**
(103 total). The original #77 branch had 66 TS / 37 JS;
its historical evidence below is separate from these integrated counts.
Issue #73 migrates the five live-observation/activity modules and their five
matching test files, adding one narrow observation port and one test helper:
**96 strict TS / 9 remaining JS inputs** (105 total).
Issue #78 tightens the already-migrated Monaco/AMD contracts and adds a strict
loader integration test. Combined with the observation migration, the manifest
contains **97 strict TS / 9 remaining JS inputs** (106 total).
It does not replace any JS input: #77 already migrated the scoped editor owners
and tests. The remaining app/workspace orchestration and server JS are outside
this consumed-contract refinement; the upstream 9-JS ceiling remains unchanged.
The original #78 branch had 85 TS / 19 JS; its evidence below is historical.
Issue #74 completes the server migration with the real Git adapter and CLI:
**99 strict TS / 7 remaining JS inputs** (106 total). HTTP/default capability
composition and its associated tests were already strict upstream; they are not
counted as newly migrated inputs. All server inputs are now TypeScript.
Issue #79 migrates the workspace controls and their direct integration test,
adding one consumed structural DOM port. Combined with #74, the manifest contains
**102 strict TS / 5 remaining JS inputs**
(107 total). The app coordinator and app-level deletion tests remain unchecked
JavaScript compatibility coverage, not claimed strict coverage.
`allowJs: true` / `checkJs: false` only lets these
listed legacy modules pass through compilation; it does **not** make their
contracts type-safe. Build/typecheck/test gates compare the manifest against
all code in the three source trees, reject unlisted imported code, and enforce
a 5-JS ceiling. New code should be TypeScript and listed explicitly.

For each migration, replace the `.js` entry with `.ts` (retain `.js` imports),
and lower the JavaScript ceiling in `scripts/build-inputs.js`. Do not add
JavaScript inputs or remove tests to improve the count. The final target is
**zero JavaScript build inputs**, with `allowJs` removed/false and no temporary
unchecked application or test code. Build/smoke orchestration in `scripts/`
is separate tooling, not shipped runtime or compiler input.

The routing helpers use honest narrow structural inputs: strings for paths,
readonly changed-path arrays, snapshots requiring only their identifying
`path` (nullable as in the existing parser), and errors requiring only a string
`message`. Snapshot extras are passed through, not falsely modelled as a full
domain record. Existing JavaScript callers remain outside strict checking until
their own migrations. #68 changed no external JSON/YAML boundary; #69's HTTP
JSON narrowing is described below.

## Reproducible checks

Use Node 20.19.0 to check the exact minimum, with its `bin` first on `PATH` so
npm and installed executable shebangs use the same Node version.

| Level | Command | What it proves |
| --- | --- | --- |
| Static, automated | `npm run typecheck` | Manifest coverage; strict migrated source/tests; native browser/fetch/EventSource/viewer/editor/comment/workspace-control/watch/filesystem/timer/Git IO, Monaco/AMD, minimal path ports and structural watchers accepted; seventy-seven invalid routing/HTTP/discovery/Git/commit/confirmation/tree/comparison/comment/workspace/control/viewer/editor/observation/Monaco/AMD calls, response shapes, fake capabilities, a range-less file anchor and unchecked YAML/JSON access rejected |
| Unit/integration, automated | `npm test` | All explicitly selected compiled tests; existing fake IO boundaries are unchanged |
| Focused unit, automated | `node --test dist/test/server/route-logic.test.js` after `npm run build` | Existing containment and framing behavior plus newline escaping, snapshot passthrough and structural error regressions |
| Focused integration, automated | Run `node --test dist/test/server/handle-request.test.js`, `node --test dist/test/server/app.test.js` and `node --test dist/test/server/app.integration.test.js` separately after `npm run build` | HTTP routing/mutations, fake Git/filesystem/comments/deletion capabilities, MIME/byte length and SSE subscription/disconnect behavior |
| IO smoke, automated | `npm run smoke:build` | Unlisted source rejection; stale-output removal in all three trees; exact HTML/CSS copying; shebang/help; real CLI and static HTML/CSS/native-module HTTP serving |
| Package IO smoke, automated | `npm run smoke:package` | Real `npm pack` prepare lifecycle; required runtime contents/no source or tests; global tarball install with production dependencies; installed CLI and HTTP assets |
| Git-source IO smoke, automated | `npm run smoke:git-install -- git+file:///absolute/path/to/committed/repository#ref` | npm's real Git clone/prepare/pack path, then global tarball install with `--omit=dev`, no installed build tools/source/tests, and working CLI/HTTP assets |

Smoke checks create/remove isolated install directories under `/tmp/opencode`.
Package checks can access the npm registry and execute the package's lifecycle
scripts. Git-source checking **requires a committed snapshot** of these changes:
Git URLs do not include working-tree edits. The check itself never commits,
pushes or creates a worktree, and never changes the source repository. Omitting
the `#ref` uses that repository's default HEAD.

### Git-source lifecycle limitation at the minimum Node version

On Node 20.19.0 with bundled npm 10.8.2, direct global Git installation fails
both with and without `--omit=dev`. The npm debug logs show that pacote requests
`install --force --include=dev --include=peer --include=optional` in the cloned
repository, but the child npm reifies the global prefix's `lib/node_modules/canopy`
as a link instead of installing the clone's development dependencies. Its
`prepare` then fails with `ERR_MODULE_NOT_FOUND` importing `typescript` from
`scripts/build-inputs.js`. This is not caused by the manifest validation or
production omission: removing validation would leave the compiler missing too.

The bundled npm implementation explains the behavior: `@npmcli/config` exports
non-default `global`/`prefix` settings into the process environment;
`pacote/lib/git.js` passes that environment into the nested install, whose
arguments include development dependencies but do not reset global mode.
Direct installation was reproduced outside `npm run`, ruling out the smoke
runner's lifecycle environment as the cause.

The supported command is the README's two-step `npm pack <Git URL>` followed by
`npm install -g --omit=dev ./canopy-0.1.0.tgz`. Non-global Git packing installs
the locked build tools in the temporary clone and runs the real prepare build;
global installation consumes only the compiled package. Keep source preparation
scripts and development dependencies enabled. Do not self-install tools from
`prepare`, promote them to runtime dependencies, or claim direct global Git
installation works on this npm version. The Git smoke checks this documented
two-step path rather than silently dropping `--omit=dev`.

## Evidence and limitations for #68

The implementation ran static gates and 64 focused compiled routing/request/app
tests, plus build and tarball installation smoke on exact Node 20.19.0. `npm ci`
and `npm run dev -- --help` also passed their real prepare/predev build lifecycles.
The static negative probe was red before helper annotations; build smoke was
red before the build entry existed; package smoke rejected stale lock bin
metadata before it was updated. Added pure routing cases characterize unchanged
behavior rather than claim new runtime fixes.

Final validation on Node 20.19.0 passed all **565 tests** with zero failures or
skips in one full-suite run. All 47 source test files mapped to unique compiled
test paths; no source/output double discovery occurred. The checked baseline
contained 562 test registrations (the issue's exploratory count was 563), and
the migration added three characterization tests. Static checks, build cleanup
and asset/CLI HTTP smoke, and the 50-entry tarball installation smoke also
passed. The lifecycle follow-up below changes only installation smoke tooling
and documentation, not application code or suite discovery.

The lifecycle follow-up reproduced both direct global Git-install failures on
snapshot `5d7abac`, then passed the revised two-step Git-source smoke against
that same committed snapshot on Node 20.19.0/npm 10.8.2: 50 package entries,
production-only global installation, absent TypeScript/Node typings and
source/build/test directories, installed CLI help and HTTP assets. Typecheck
and all 8 focused compiled routing tests also passed. No full-suite rerun was
performed in the lifecycle follow-up.

HTTP smoke fetches static modules but does not execute them in a browser. No
manual browser evaluation is claimed here. Existing integration tests retain
their fake Git, filesystem and watcher edges: they do not prove real Monaco
layout/focus/IME, real filesystem watcher behavior, or destructive Git actions.
Those require the existing user-run browser/demo checks and separately controlled
real-IO evaluation, not confidence inferred from stubs.

## HTTP migration evidence and limitations for #69

`RequestDescription`, exclusive body/SSE `ResponseDescription` variants and
explicit capability ports cover the HTTP seams. Worktree snapshots require only
the identifying nullable path; opaque tree, commit, comment and deletion results
remain `unknown` where HTTP only serializes them. These ports describe consumed
contracts, not complete domain models or proof that the remaining JavaScript
implementations are strictly checked. Tests use typed overrides rather than
inferred legacy `any`. Caught error fields are inspected from `unknown`; existing
status, disclosure, conflict and removal outcome responses are retained.

Incoming comment JSON is parsed as `unknown`, then narrowed to a non-null,
non-array object with unknown field values. Field/action/revision validation
still belongs to the existing comment store: the HTTP boundary does not assert
that an object is a valid thread, reply or resolution. An integration regression
wires that real store to filesystem operations that fail if called, checking
twelve malformed object inputs and the original 400 error envelopes without IO.
No YAML parser or comment-store domain migration is claimed.

On Node **22.22.1**, `npm ci` installed only existing locked dependencies and ran
the prepare build. `npm run typecheck` and `npm run build` passed. Separate focused
compiled runs passed **33 request-handler + 25 app + 2 app-integration tests**
(60 total, no failures/skips). All original registrations and invalid-input
cases remain; four integration regressions were added. The additional static
asset IO seam defaults to the same `readFile` implementation and allows fake
filesystem integration coverage. Static asset GET/HEAD tests include multibyte
byte length, all existing MIME mappings and read failure.

Red/green evidence is type-driven or fixture-wiring evidence, not a claim that
this migration discovered and fixed unrelated runtime bugs:

- The HTTP negative probe failed before typed ports: unchecked comment input
  access was not rejected. It passed after the migration. The exclusive-response
  probe separately failed while simultaneous body/SSE responses were accepted,
  then passed with the response union. Eleven invalid calls/shapes now fail.
- Fake static HTTP integration was compiler-red with a missing `readStatic`
  option (TS2353), then green after exposing that existing IO edge.
- Malformed object integration was runtime-red (201 instead of 400) against the
  fixture's success stub, then green when wired to the real comment store.
- HTTP POST regression was compiler-red before the typed request fixture could
  carry headers/body (TS2554), then green after that fixture wiring. Activity SSE
  regression was compiler-red for untyped captured callbacks/cleanup signals,
  then green with explicit ports and `Promise<void>`.

Most behavior coverage is at `createRequestHandler` or the `createApp` HTTP seam;
the existing pure routing unit tests are retained. Focused coverage uses fake Git,
filesystem, comments, deletion, activity and watcher capabilities; local HTTP
transport is real. Some retained app tests also read compiled static assets, but
default worktree listing in their shared fixture is now fake, avoiding real Git.
Final automated validation on Node **22.22.1** passed `npm run typecheck`
(including all eleven negative probes), all **569 compiled tests** with zero
failures or skips, `npm run smoke:build`, and the staged diff whitespace check.
The build smoke exercises real CLI/static HTTP serving, not browser execution.
The agreed HTTP adapter seam uses real loopback transport to check headers,
bodies and disconnect cleanup while simulating external capabilities.
No minimum-Node rerun, package smoke or manual browser evaluation was performed
for #69. This evidence does not establish real Monaco, filesystem watcher
reliability or destructive Git correctness. The existing static-prefix guard
and unrelated behavior are intentionally unchanged.

## Evidence and limitations for #70

The per-issue evidence below records the original isolated implementation,
not the cumulative integration branch. The #69 evidence above likewise records
its original branch.

Discovery, porcelain parsing, commit listing and deletion assessment now use
strict TypeScript, with a shared `Git` port requiring only arguments, working
directory and string stdout. Commit fields remain possibly undefined for
malformed log records rather than inventing parser validation or changing the
existing output. The reusable test fake records calls, accepts canned responses
or a stateful handler, and rejects unconfigured commands; it is **not** a Git
emulator. HTTP/SSE test JSON is parsed as unknown and checked before inspection.
The adjacent legacy polling module only gains an honest generic timer/snapshot
port annotation; its implementation remains unchecked pending its own ticket.

Automated evidence in this implementation worktree (Node 22.22.1):

- `npm ci` passed the locked dependency install and real prepare/build lifecycle;
  no dependency changes or new packages were introduced.
- `npm run typecheck` passed: **15 strict TS / 82 temporary JS inputs**, with
  the JavaScript ceiling lowered to 82 and all nine static negative probes
  rejected. The original invalid-input and fake-Git deletion-failure cases
  remain; an empty raw branch field still fails closed during assessment.
- `npm run build` passed. Direct compiled runs of the six migrated test files
  passed **43 tests**. Final focused execution also included the adjacent app,
  request-handler and worktree-polling tests: **113 passed, 0 failed/skipped**.
  The focused command was `node --test` with the nine explicit paths under
  `dist/test/server/`: `porcelain.test.js`, `commits.test.js`,
  `origin-main.test.js`, `origin-main-live.test.js`, `worktree-delete.test.js`,
  `app.integration.test.js`, `app.test.js`, `handle-request.test.js` and
  `worktree-watch.test.js`. `scripts/test.js` always appends the full manifest,
  so direct compiled paths are used for focused runs.
- New fail-closed fake-Git coverage used a red-green slice through
  `createListWorktrees`: the discovery-refusal test failed with **Missing
  expected rejection** while an unconfigured fake command returned empty
  stdout, then passed when the reusable fake rejected it. The additional
  discovery/order and reference-identity assertions characterize existing
  behavior. Parsing is the thin unit layer; the majority of directly scoped
  cases integrate real modules over fake Git, with one real loopback HTTP test.

- Final independent validation passed `npm run typecheck`, `npm test` and
  `git diff --cached --check` on Node 22.22.1. The full compiled suite passed
  **567 tests, 0 failed/skipped/cancelled**. The runner used explicit compiled
  manifest paths, without source/output double discovery.
- The two-axis review found no spec violations or hard standards breaches.
  Its optional duplicated-fixture-key finding was addressed with a typed
  mutation table, retaining all 12 snapshot changes. After that test-only
  cleanup, typecheck, build, all **10 compiled deletion tests** and whitespace
  checks passed; the full suite was not rerun.

No exact-minimum Node rerun, package/build smoke rerun, manual browser evaluation
or live destructive Git deletion was performed for this ticket. Successful
fake deletion tests establish command/result orchestration only; negative and
partial-failure cases establish simulated safety behavior, **not** proof of
live Git/filesystem destruction, watcher behavior or race freedom. No external
YAML application boundary is changed by this ticket.

## Cumulative integration validation (#69 and #70)

On Node 22.22.1, the integrated #69 step passed typecheck and all 60 focused
compiled HTTP tests with 7 TS / 87 JS inputs. The integrated #70 step passed
typecheck (all sixteen combined negative probes), build and all 117 focused
compiled tests using the nine paths listed in its historical evidence, with
19 TS / 78 JS inputs. These counts come from the combined manifest, not summed
branch totals. The shared HTTP integration file retains the static MIME/HEAD
regression, both discovery regressions and one Git-backed HTTP smoke using the
reusable fail-closed fake. Unused request capabilities in the live-ref fixture
now fail closed instead of passing undefined. The polling port accepts readonly
snapshots and the HTTP adapter narrows unknown polling errors before forwarding
their message. External Git, filesystem and watcher limitations remain unchanged.

## Implementation evidence and limitations for #75

This section records the original isolated #75 branch, not the cumulative
integration branch.

Migrated sources: `collect-files`, `changed-files`, `worktree-select`,
`comments-after-load`, `comments-view`, `comment-range`, `view-mode`,
`auto-scroll`, `watch-preference`, `commit-lock`, `tree-state`,
`keyboard-shortcuts`, `relative-time`, `edit-time`, `tab-flash`, `tab-scroll`
and `rail-resize`. Their matching test files and `test/public/fake-dom` are
strict TypeScript too (35 JavaScript inputs replaced). `comment-dom` and
`preference-storage` describe only consumed structural capabilities. The
manifest, decreasing JS ceiling and static probe are updated; `.js` imports,
compiled serving, orchestration and dependencies are unchanged.

Automated implementation checks on Node 22.22.1:

- **Static:** regular `npm run typecheck` and builds pass, checking all 39 TS
  inputs. The added positive native-DOM probe was red because focus restoration
  inferred an overly broad containment input; it became green after narrowing
  the focus port and making the document determine its element type. Negative
  probes reject a fake as `Document`, an unsupported fake-document selector and
  a file conversation without its required range. There are no casts of fake
  DOM objects to browser classes or suppressed compiler errors.
- **Unit/integration:** all **102 tests** in the 17 migrated compiled test files
  passed. Existing invalid selection tests still enter an `unknown` validation
  boundary. Preference and rail tests simulate storage/window operations;
  comment rendering simulates element events, drafts and pending saves. The
  shared DOM helper is explicitly partial (for example, class-only selectors
  and one listener per event), not a substitute for native DOM fidelity.
- **Compatibility integration:** **179 tests** in the compiled app,
  workspace-state/UI, viewer, Monaco-view, comments-flow, replies and reconnect
  files passed, exercising remaining JS consumers with the migrated helpers.
  Comment JSON/YAML parsing and validation remain at their existing loader
  boundaries; this migration does not reinterpret malformed writes as valid
  conversations or narrow away their warning/retention tests.

- **Final validation:** `npm run typecheck`, all **565 compiled tests** in one
  full `npm test` run (zero failures), `npm run smoke:build` and the staged diff
  whitespace check passed on Node 22.22.1. Build smoke verifies manifest guards,
  stale-output cleanup and native `.js` module HTTP serving; it does not execute
  the modules in a browser. Independent Standards and Spec reviews of the full
  diff against the worktree's starting commit `bcce38b` found no actionable issues.

No manual browser/E2E evaluation or real watcher/destructive Git testing was
performed. Simulated focus/pointer/storage behavior and compile-time native
compatibility do not prove actual layout, native focus/selection/IME, pointer
capture or cross-browser persistence behavior. Larger browser/workspace
orchestrators and the 57 remaining JS inputs are still outside strict checking.

## Final cumulative integration validation (#69, #70 and #75)

On Node 22.22.1, the #75 integration step passed typecheck, including native
Document/Window positive controls and all **nineteen** combined negative probes,
build and all **102** focused compiled browser tests in the 17 migrated files.
The actual manifest contains **56 TS / 43 JS inputs** (99 total), with a 43-JS
ceiling. Final `npm test` passed **571 compiled tests, 0 failed/skipped/cancelled**;
`npm run smoke:build` passed manifest rejection, stale cleanup and real CLI/static
HTML/CSS/native-module HTTP serving. These are cumulative results, distinct from
the historical isolated branch counts of 569, 567 and 565 above.

Integration self-review inspected the complete source/test/tooling diff against
`bcce38b2d357e6b87e55243dd7e625de2aa85264` and the original acceptance criteria
for #69, #70 and #75. All issue evidence sections, migrated manifest entries,
invalid-input cases and static probes are retained. No blanket `any`, compiler
suppression, unsafe assertions or fake-to-native DOM casts were introduced;
the retained `as const` test tables only preserve literal/readonly inference.
The cumulative diff whitespace check passed. No independent review, minimum-Node
rerun, package/Git-install smoke or manual browser evaluation was performed in
this integration session. Fake capabilities do not establish native browser
layout/focus/IME, watcher reliability or live destructive Git safety.

## Implementation evidence and limitations for #72

This section records #72 before integrating #71, not the combined rebase result.

The five durable-comment modules (`comments`, `comments-header`, `comment-loader`,
`comment-store` and `sidecar-path`) and their three existing test files are now
strict TypeScript. The manifest contains **64 TS / 35 JS inputs**, with the JS
ceiling lowered from 43 to 35. Native `.js` imports and the emitted header are
unchanged; no dependencies were added.

YAML `toJS` results enter as `unknown`; exact-key, path, message, timestamp and
thread validation narrows them before use. HTTP request fields remain unknown
until the existing validators accept them. Mutation helpers take typed requests,
while the store continues accepting invalid field values for runtime validation.
Read/path/write ports require only consumed capabilities; the clock only needs
`toISOString`, and fake stats are not asserted to be native filesystem objects.
Caught values and integration JSON are inspected from `unknown`.

Automated validation on Node **22.22.1**:

- **Static:** `npm run typecheck` passed regularly. All **26 negative probes**
  are rejected, including seven new comment/path/IO/unchecked-YAML probes.
  Positive controls accept native read IO, minimal path-only IO and malformed
  fields at the store's runtime validation boundary. There are no blanket `any`,
  compiler suppressions or unsafe assertions in the migration.
- **Unit/integration:** all **39 compiled tests** in the three migrated files
  passed as part of a focused **76-test** run also including the request handler
  and app integration files. All original invalid-input cases remain. The added
  public-seam regression wires the real handler, store and loader over fake IO,
  IDs and clock: a queued save after a failed write succeeds, removes the partial
  temp file, retains exact IDs/timestamps, loads, resolves and reopens on reply.
  Its fixture wiring was compiler-red (a one-shot failure callback was not yet
  accepted), then green after typing and implementing that simulated capability.
  An initial expected failure-envelope assertion was corrected to retain the
  existing `conflict: false` and `revision: null` fields; no runtime fix is claimed.
- **Final:** `npm ci` passed the existing locked install/prepare lifecycle;
  `npm run typecheck`, one full `npm test` run (**572 passed, 0 failed/skipped/
  cancelled**) and `npm run smoke:build` passed. The test runner maps the explicit
  manifest to unique `dist/test/**/*.test.js` paths, and focused runs used those
  compiled paths directly rather than source tests.

Pure schema/serialization unit tests are retained; durable lifecycle and failure
confidence is primarily integration coverage at the existing fake-IO seam.
These tests do not prove real sidecar filesystem durability, symlink/open behavior,
watcher reliability or race freedom. The existing external-writer race between
the final revision recheck and rename remains documented and unchanged. Build
smoke establishes real CLI/static HTTP asset serving, not durable-storage or
browser behavior. No manual browser/E2E, minimum-Node or package/Git-install smoke
evaluation was performed for this ticket.

## Implementation evidence and limitations for #71

This section records the original #71 branch, not the combined rebase result.

`status`, `file-content`, `pair-renames` and their matching tests are strict
TypeScript. Status entries and file/directory nodes retain their existing
metadata and shapes. Filesystem ports consume only UTF-8 text or numeric
`mtimeMs`; the native default readers and `stat` satisfy those ports without
casts. The shared Git port now also describes optional numeric `maxBuffer`.
Comparison loading still requests **32 MiB** for `show`, and the fail-closed
test fake records that option without pretending to emulate Git. Explicit refs
still resolve before lookup; missing locked paths still require `ls-tree`
confirmation. Caught error values are narrowed from `unknown`. No external
JSON/YAML boundary, dependency or compiled/native `.js` import is changed.

Automated implementation evidence on Node **22.22.1**:

- **Static:** `npm ci` installed existing locked dependencies and passed its
  prepare build. Repeated `npm run typecheck` and `npm run build` passed with
  **62 TS / 37 JS inputs**, a lowered 37-JS ceiling and all **25** negative probes
  rejected. The six additional probes reject a non-string comparison path,
  non-numeric stat time, unsupported file status, non-numeric Git buffer limit,
  non-text filesystem result and non-text rename content.
- **Red/green:** the comparison-path negative probe was red while the legacy
  loader accepted a numeric path, then green after typing it. The unsupported
  status probe was separately red while the legacy tree helper accepted it,
  then green after the status migration. The invalid-stat probe already rejected
  its input before migration; it is a retained check, not claimed as a new red.
  Added runtime cases characterize unchanged behavior, not unrelated bug fixes.
- **Unit/integration:** direct compiled execution of `status.test.js`,
  `file-content.test.js` and `pair-renames.test.js` under `dist/test/server/`
  passed **76 tests, 0 failed/skipped/cancelled**. Existing pure parsing/tree/
  similarity tests remain. Integration cases use the real public loaders with
  fake Git/filesystem capabilities, covering nested tracked/untracked/ref trees,
  rename old paths flowing into comparisons, both missing sides, genuine Git/
  working-read failures, lookup failures, unreadable rename candidates, stat
  failures/non-finite times and the 32-MiB option. Eight integration registrations
  were added; all existing registrations and invalid-ref/failure cases remain.
- **Compatibility integration:** a separate focused compiled run of `commits`,
  `origin-main-live`, `worktree-delete`, `app.integration`, `app` and
  `handle-request` passed **90 tests, 0 failed/skipped/cancelled**, checking shared
  fake-Git users and adjacent HTTP behavior. HTTP adapter tests use real loopback
  transport; their Git and mutation capabilities are simulated.

Final independent validation on Node **22.22.1** passed `npm run typecheck`,
the full `npm test` compiled suite (**579 passed, 0 failed/skipped/cancelled**)
and `git diff --cached --check`. Separate Standards and Spec reviews inspected
the complete staged diff against the worktree's starting commit `aa73323` and
found no actionable issues on either axis.

No exact-minimum Node rerun, package/build IO smoke, manual browser evaluation
or live Git/filesystem loading was performed for #71. Fake failures demonstrate
orchestration and error semantics,
not real Git rename fidelity, actual filesystem races, native browser rendering,
watcher reliability or destructive Git safety.

## Rebase integration validation (#71 and #72)

Rebasing #71's original commit `8bbe30c` onto `166e78a` retained both migrations,
all manifest entries and both sets of static probes. The combined source trees
and explicit manifest contain **70 TS / 29 JS inputs** (99 total), with a 29-JS
ceiling. Historical per-issue validation above is not evidence of rerunning those
checks on this combined snapshot.

On Node **22.22.1**, this rebase pass ran `npm run typecheck` (all **32** combined
negative probes rejected; native browser/comment IO and minimal path positive
controls accepted), `npm run build`, and
`node --test dist/test/server/status.test.js dist/test/server/file-content.test.js dist/test/server/pair-renames.test.js`:
**76 passed, 0 failed/skipped/cancelled**.

No full-suite, smoke, minimum-Node, manual browser or live Git/filesystem rerun
was performed in this rebase pass. The fake-IO and real-runtime limitations
documented in the historical evidence remain unchanged.
## Implementation evidence and limitations for #76

This section records the original #76 branch, not the combined rebase result.

`workspace-state` and `live-updates`, plus their two direct test files, now use
strict TypeScript. `workspace-contracts` holds consumed structural JSON and fetch
contracts. Browser `.js` specifiers and compiled serving remain unchanged. The
explicit manifest contains **61 TS / 39 JS inputs** (100 total); the JS ceiling
is 39. No new packages or dependency changes were introduced. Existing locked
dependencies were installed with `npm ci`, including its prepare/build lifecycle.

Fetched resource JSON and mutation error bodies remain `unknown` until narrowed.
File content requires both API sides as strings or null; recursive trees validate
their names, paths, status and optional rename/mtime fields. The commit parser
always gets a first string field from `split`, so the picker requires a string
SHA, but permits omitted message/date fields from malformed log records rather
than inventing a complete log record. Worktree paths retain the parser's nullable
shape; consumed metadata is optional and validated when present. Other metadata
is retained as unknown extras, including in the existing metadata comparison.
The existing selection/lock/expansion helpers now admit those nullable paths,
and the flattened file contract carries the old path used by rename comparisons.

Comment JSON validates the consumed conversation/message and file-range
structure, not YAML syntax, exact sidecar keys, timestamps or identifier
uniqueness. Those semantics still belong to the server loader/store, whose #72
migration preserves its runtime validation.
Malformed reads follow existing resource errors or the comment warning/retention
path and cannot enable saves. Caught values are narrowed from unknown; resource
failures expose an Error message, and malformed mutation error envelopes fall
back to the existing status message. Minimal conversation/content/tree fixtures
were made honest API values rather than asserted into domain types; existing
sidecar warning and failed-JSON negative tests remain.

SSE parsing validates changed paths, worktrees, finite-number-or-null activity
snapshots and poll-error messages before delivery. Invalid messages are logged
through the existing console-error channel and ignored without closing a stream,
changing selection or corrupting activity. Stale/closing/disposed sources are
checked before decoding. `app.js` remains an unchecked coordinator, but its
startup and post-deletion worktree fetches use the same validated worktree
boundary as SSE. Native fetch and EventSource constructors satisfy the narrow
IO ports; fake sources remain structural capabilities, not assertions to browser
classes. No private validator/function test seam was added.

Automated implementation evidence on **Node 22.22.1**:

- **Static:** regular `npm run typecheck` and strict builds passed. All **25**
  negative probes reject the intended invalid calls/shapes, including unchecked
  JSON access; positive controls accept native browser/fetch/EventSource ports.
  The native EventSource control was initially compiler-red because an overly
  narrow zero-argument `onopen` property excluded the browser callback shape,
  then green after typing the consumed handler properties honestly.
- **Integration:** all **68** compiled workspace/live-update cases passed using
  real owners and their real navigation/lock/comment-retention collaborators,
  with only fetch/EventSource faked. Existing generation, switch-away/back,
  rename/locked-comparison, metadata/status-only, refresh/mutation-race and
  reconnect/cleanup cases remain. Individual malformed content, nested tree,
  commit-marker, comment-range, missing-SHA, SSE and startup-worktree slices were
  runtime-red before validation and green afterward. Additional decoding-failure
  and stale-malformed-payload cases characterize established error/generation
  behavior; no failing typing-only behavior was fabricated.
- **Focused compatibility/unit:** one final explicit compiled run passed **169
  tests, 0 failed/skipped/cancelled**: workspace-state, live-updates, app,
  workspace-ui, reconnect, replies, comments-flow, collect-files, commit-lock,
  tree-state and worktree-select. This includes the 68 directly migrated cases,
  81 unchecked app/UI/viewer/sidecar compatibility cases and 20 typed helper cases.
  Reconnect's three app-level cases remain JavaScript because strict migration
  would require the broader unchecked app/DOM/editor ports; they are compatibility
  coverage, not claimed strict test coverage.

- **Independent final validation:** `npm run typecheck` and `npm test` passed;
  the latter built first and ran compiled `dist/` tests only: **580 passed,
  0 failed/skipped**. The staged diff whitespace check also passed.

No manual/browser/E2E evaluation, minimum-Node rerun, package/build smoke or real
watcher/destructive Git test is claimed. Fake IO and DOM/editor capabilities establish orchestration and
simulated lifecycle behavior, not native layout/focus/IME, network reconnect
reliability, filesystem watcher delivery or live Git safety.

## Rebase integration validation (#71, #72 and #76)

Replaying #76's original commit `fd35cb3` onto `ee23750` retained the upstream
file-tree/comparison and durable-comment migrations, the workspace contracts and
tests, and both sets of static probes. The combined explicit manifest and source
trees contain **75 TS / 25 JS inputs** (100 total), with a 25-JS ceiling. The
per-issue evidence above records historical branch checks, not this snapshot.

On Node **22.22.1**, this rebase pass passed `npm run typecheck` (all **38**
combined negative probes rejected; native browser/fetch/EventSource/comment IO
and minimal path positive controls accepted), `npm run build`, and a focused
`node --test` run of eleven explicit compiled paths under `dist/test/public/`:
`workspace-state.test.js`, `live-updates.test.js`, `app.test.js`,
`workspace-ui.test.js`, `reconnect.test.js`, `replies.test.js`,
`comments-flow.test.js`, `collect-files.test.js`, `commit-lock.test.js`,
`tree-state.test.js` and `worktree-select.test.js`. All **169 tests passed**, with
zero failures, skips or cancellations. The comments-flow seam includes the real
migrated server route/loader and browser workspace over fake filesystem IO.

No full-suite, smoke, minimum-Node, manual browser or live Git/filesystem rerun
was performed in this conflict-resolution pass. The fake-IO and real-runtime
limitations documented above remain unchanged; full-suite final validation is
separate.

## Implementation evidence and limitations for #77

This section records the original #77 branch, not the combined rebase result.

Starting commit: `aa73323`. `public/viewer` and `public/monaco-view`, plus
`test/public/{viewer,monaco-view,comments-flow,replies}.test`, now compile as
strict TypeScript. Native `.js` imports, the real conversation/editor lifecycle
owners, all existing test registrations and failure/negative cases remain.
Two incremental characterization cases cover blocked reply/resolution forms
through the viewer and a late mount rejection after viewer disposal. These
characterize existing behavior; they are not claims of new runtime fixes.

`editor-port` reuses the recursive comment DOM contracts. `monaco-port` describes
only consumed CDN mounting capabilities: partial editor capabilities are bound
to their real receiver, and an unsupported capability throws if exercised.
Tests do not masquerade as Monaco classes, native Document/Window or native timer
handles. Mounting nodes are opaque only at the CDN IO port; public mount calls
require native or structural viewer elements. Native Document, Element and
ResizeObserver positive static controls remain checked. `ES2023` library types
cover the already-existing `findLastIndex` use; the emit target stays ES2022.

The shared fake DOM adds measured geometry, selection and single-owner
reparenting/blur. Lifecycle tests explicitly opt into connected-only focus;
older control tests retain their detached focus-request convention. It still
has class-only selectors and one listener per event, not complete browser DOM
fidelity. The legacy workspace owner stays real behind a test-only boundary
that reads its unchecked state as `unknown` and validates consumed fields.
HTTP JSON, mutation JSON and parsed YAML results likewise stay unknown until
checked. The existing real YAML/comment validation and conflict flow are retained;
no production YAML/parser or workspace migration is claimed. Adjacent JS changes
only annotate consumed filesystem/clock/ID and remote-change ports.

### Automated checks (Node 22.22.1)

- `npm ci` installed only existing locked dependencies and passed prepare/build.
  The first typecheck attempt reported missing TypeScript before this install;
  dependencies and lockfile are unchanged.
- Regular `npm run typecheck` and `npm run build` passed throughout the typed
  slices. The final manifest is **66 TS / 37 JS** and the JS ceiling is 37.
  All **22 negative static probes** pass, including invalid viewer elements,
  editor content and reply callback use, alongside native positive controls.
- Static red/green evidence: the incremental viewer gate failed before typing,
  initially on the legacy parameter/call shape rather than the desired numeric
  element diagnostic. A subsequent read-only virtual compiler control using
  `git show aa73323:public/viewer.js` independently confirmed the complete
  numeric-`mainEl` call was accepted by the baseline; the final gate rejects it
  with TS2322. The native positive control also caught a too-narrow HTMLElement
  focus annotation (TS2322); using Document's actual Element focus domain passed.
  Compiler-red fixtures drove narrow filesystem and nullable remote-change ports
  rather than casts to native filesystem/DOM/editor classes.
- Individual compiled runs passed **21 viewer**, **29 Monaco-view**, **1
  comments-flow** and **9 replies** tests. The focused command is
  `node --test dist/test/public/viewer.test.js dist/test/public/monaco-view.test.js dist/test/public/comments-flow.test.js dist/test/public/replies.test.js`:
  **60 passed, zero failures/skips/cancellations**.
- `npm run smoke:build` passed unlisted-input rejection, stale-output cleanup,
  copied assets and real CLI/static HTML/CSS/native-module HTTP serving.
- The first full `npm test` run found one fake-DOM compatibility regression
  (**572 passed / 1 failed**): connected-only focus had inadvertently replaced
  the existing detached-focus convention. After making that behavior an explicit
  lifecycle-fixture opt-in, the focused comments-view/replies run passed **21**
  tests. One necessary full-suite rerun then passed **573 compiled tests, zero
  failures/skips/cancellations**. No existing test was removed or weakened.
- `git diff --check` passed. No dependency additions were made.
- Independent final checks passed typecheck (**66 TS / 37 JS**, 22 negative
  probes), build, all **60 focused compiled tests**, and staged whitespace checks.
  Standards and Spec reviews inspected the complete staged diff against
  `aa73323`: no documented-standard breaches or actionable spec findings.
  Standards noted one optional duplicated error-message helper; it is left as a
  non-blocking follow-up rather than broadening this migration.

### Manual evaluation and remaining limits

No browser evaluation, minimum-Node rerun, package/Git-install smoke, real watcher
evaluation or destructive Git action was performed for #77. The build smoke
fetches modules but does not execute them in a browser. Simulated mounting,
geometry, focus and selection demonstrate owner orchestration only; they do not
prove real Monaco layout, keyboard focus, native selection/IME, browser event
fidelity, watcher reliability or live destructive Git safety. The remaining 37
JS inputs, including production workspace and YAML/comment services, are not
claimed to be strictly checked.

## Rebase integration validation (#71, #72 and #77)

This section records rebasing #77's original commit `6c6501f` onto `c700313`,
the initial target before a subsequent rebase onto #76's `00a5718`. Its checks
are historical evidence for that initial snapshot only, separate from the
latest-target validation below and the original #77 evidence above. Both upstream strict
comment-service and file-tree migrations are retained alongside the real
viewer/editor lifecycle migration. Deleted service JavaScript is not restored:
upstream `ReadIo`, `WriteIo` and `CommentStoreOptions` replace #77's adjacent
legacy JSDoc annotations. The comments-flow fake explicitly implements the real
`WriteIo` port; conversation-fixture and replies retain their unknown-boundary
validation and need no API changes. No runtime service behavior is changed.

The auto-merged manifest was checked against all source-tree code by the build
gate: **80 strict TS / 23 temporary JS inputs** (103 total), with a lowered
23-JS ceiling. The ES2023/DOM library selection retains ES2022 emit and native
`.js` imports. All previous static probes are preserved alongside #77's three
additional probes; no invalid-input or failure coverage was removed.

Automated rebase checks on Node **22.22.1**:

- **Static:** `npm run typecheck` passed, accepting native browser/viewer/editor/
  comment IO and minimal path positive controls and rejecting all **35** combined
  negative probes. `npm run build` passed.
- **Unit/integration:** direct compiled execution of the four #77 test files
  (`viewer`, `monaco-view`, `comments-flow`, `replies`) plus server `comments`,
  `comment-loader`, `comment-store`, `handle-request` and `app.integration`
  passed **136 tests, 0 failed/skipped/cancelled**. This includes 60 viewer/editor
  cases and 76 durable-comment/adjacent HTTP cases, over simulated IO edges.
- **Full suite:** one `npm test` run after the resolutions passed **582 compiled
  tests, 0 failed/skipped/cancelled**, including its pretest build.
- Working-tree and staged whitespace checks passed. No dependencies were added.

No smoke, minimum-Node, manual browser or live Git/filesystem evaluation was
rerun during this rebase. Simulated lifecycle and failure coverage does not prove
native Monaco layout/focus/IME, actual sidecar durability or race freedom, watcher
reliability or destructive Git safety. The remaining workspace and other legacy
JS inputs are still unchecked; YAML/comment services are now strictly checked
through the retained upstream #72 migration, unlike the historical #77 branch.

## Latest-target rebase validation (#71, #72, #76 and #77)

After the initial `c700313` resolution recorded above, the shared upstream ref
advanced to **`00a5718`**, which includes #76. This pass replays the first resolved
#77 commit `1e43fa3` onto that actual latest target. The original #77 and initial
rebase checks remain historical evidence, not results for this latest snapshot.

Upstream `workspace-state.ts`, `live-updates.ts` and `workspace-contracts.ts` are
retained without runtime changes, including readonly/null remote-change inputs,
unknown network JSON validation, stale-generation guards and failure retention.
Comments-flow and replies now import the real typed workspace owner directly.
The obsolete `conversation-fixture.ts` wrapper and its manifest entry are removed;
typed server parsing supplies YAML results, while mutation JSON is still inspected
from unknown using the upstream record guard. Existing honest tree fixture fields
from #76 are retained. All #77 test registrations and negative/failure assertions
remain; no deleted production JavaScript is restored and no unsafe casts, blanket
`any` or compiler suppressions are introduced.

On Node **22.22.1**, this latest integration passed:

- **Static/build:** `npm run typecheck` and `npm run build`; the explicit manifest
  matches **84 strict TS / 19 temporary JS inputs** (103 total), with a 19-JS
  ceiling. All **41 negative probes** (38 upstream plus three viewer/editor)
  reject invalid calls/shapes; native browser/fetch/EventSource/viewer/editor/
  comment IO and minimal path positive controls pass.
- **Focused unit/integration:** direct compiled `node --test` execution of
  `viewer`, `monaco-view`, `comments-flow`, `replies`, `workspace-state` and
  `live-updates` under `dist/test/public/` passed **128 tests, 0 failed/skipped/
  cancelled** (60 #77 cases plus 68 upstream workspace/live cases).
- **Full suite:** one `npm test` run after the latest fixes passed **591 compiled
  tests, 0 failed/skipped/cancelled**, including its pretest build.
- Working-tree and staged whitespace checks passed. No dependencies were added.

No smoke, minimum-Node, manual browser or live Git/filesystem evaluation was
rerun in this pass. Simulated browser and IO capabilities establish owner
orchestration and failure behavior, not native Monaco layout/focus/IME, network
reconnect reliability, actual filesystem durability/race freedom, watcher delivery
or live destructive Git safety. The remaining 19 JS inputs are unchecked; the
workspace/live and durable-comment owners are now strictly checked through the
retained upstream migrations.

## Implementation evidence and limitations for #73

Starting commit: `d131246`. The five observation owners (`watch-policy`,
`watcher`, `worktree-watch`, `worktree-activity`, `fan-out`) and their matching
tests now compile as strict TypeScript. The explicit manifest contains **96 TS /
9 JS inputs** (105 total); ten JavaScript inputs were replaced and the two
consumed-capability/test helpers were added. The JavaScript ceiling is 9.
Native `.js` ESM imports and dependencies are unchanged.

The observation port describes only file/error/readiness events, close,
consumed watch options and native/string/numeric timer handles. Stats describe
only consumed optional file/directory/mtime capabilities, reusing the typed
sidecar path stat vocabulary; index resolution reuses the shared `Git` port.
Fake watchers and hand-cranked schedulers are not asserted into native classes.
Fan-out values and failures are generic, with a discriminated successful-value
cache that distinguishes an actual undefined value from no successful emission.
Polling errors remain unknown. The adjacent `origin-main-live` fixture now
narrows polling failures into the HTTP message envelope, as the production app
already does. JSON/YAML validation remains at the existing migrated boundaries;
there is no new trusted parser result or change to those validators.

Porcelain paths remain nullable at the activity-feed seam rather than being
asserted into filesystem paths. Its native observation adapter rejects a null
path, as the previous native path-policy boundary did; injected feed observation
still receives that nullable input. Bare worktrees remain unobserved. Gitignore
cache/fail-open diagnostics, regular-file-only rule reads, symlink traversal and
the content-only sidecar exception are retained. File edit and index status
notifications, sequential polling/replay, per-mode monotonic timestamps and
teardown/stale-callback guards retain their established behavior.

### Automated implementation checks (Node 22.22.1)

- **Static:** regular `npm run typecheck` passes with strict source/tests,
  manifest coverage, native chokidar/filesystem/timer positive controls and all
  **52 negative probes** rejected (41 retained + 11 observation probes). There
  are no blanket `any`, compiler suppressions or unsafe assertions in this slice.
- **Type-driven red/green:** the policy-path probe was added before migration;
  the gate failed because `createWatchPolicy(42)` was accepted by unchecked JS.
  It passed after typing the policy. Separately, the invalid fan-out source
  cleanup probe was accepted before that owner's migration (gate red), then
  rejected afterward with TS2345 (gate green). Intermediate strict fixture
  failures drove typed watcher callbacks, deferred promises and captured mock
  diagnostics, not fake native objects. These are typing failures, not claims
  of unrelated runtime defects or fabricated failing recovery behavior.
- **Unit/integration:** each of the five migrated compiled test files was run
  individually during the slices. The final focused command was `node --test`
  with nine explicit paths under `dist/test/server/`: `watch-policy.test.js`,
  `watcher.test.js`, `worktree-watch.test.js`, `worktree-activity.test.js`,
  `fan-out.test.js`, `app.test.js`, `handle-request.test.js`,
  `app.integration.test.js` and the necessarily adjusted
  `origin-main-live.test.js`. After `npm run build`, **129 tests passed, zero
  failures/skips/cancellations**: 63 directly migrated tests and 66 adjacent
  compatibility tests.
- All **61 original scoped test registrations** and their names remain; two
  integration registrations were added. The Git-backed fail-then-recover poll
  integrates real discovery, polling and fan-out over fail-closed fake Git and
  timers. It verifies cached success through failure, live-only errors, replay
  without extra Git calls, next-tick recovery/deduplication, 2000-ms cadence and
  last-subscriber cleanup. The activity integration wires real feed/poll/policy/
  observation owners over fake watcher/filesystem/clock/timer IO, checking shared
  polling, isolated mode timestamps, monotonic updates, failure/recovery, bare
  paths, removed watchers, late events and complete teardown. These additions
  characterize existing runtime behavior and passed without a runtime fix.
- `git diff --check` and a separate whitespace check of the new untracked TS
  files passed; a baseline/current test-name comparison confirmed registration
  retention.
- **Final independent validation:** on Node **22.22.1**, `npm run typecheck`
  passed (96 TS / 9 JS inputs, all 52 negative probes rejected). One full
  `npm test` run built and executed compiled output: **593 passed, 0 failed,
  skipped or cancelled**. `git diff --cached --check` passed. Separate Standards
  and Spec reviews inspected the complete staged diff against `d131246` and
  found no documented breaches or actionable findings on either axis.

Coverage follows the agreed testing trophy: static checks, the retained thin
pure policy/equality/fan-out layer, and primarily public-seam integration with
fake external IO. Adjacent HTTP tests use real loopback transport; some retained
static-serving cases read compiled assets. No smoke, minimum-Node, manual/E2E,
real watcher or destructive Git evaluation was performed. Fakes establish
orchestration, failure and timing semantics, not actual filesystem-event delivery,
native symlink/race fidelity, real Monaco layout/focus/IME or live Git safety.

## Implementation evidence and limitations for #78

This section records the original #78 branch, not the latest combined rebase.

Starting commit: `d131246`. The editor owners and associated tests are already
strict TypeScript through #77; this issue refines their consumed contracts,
rather than claiming the same migration twice. The manifest now contains **85
strict TS / 19 temporary JS inputs** (104 total), including the new loader test.
There is **no JS reduction** in this scoped refinement and no dependency change.
Native browser `.js` imports, the classic CDN AMD script and existing loading
cache behavior remain unchanged; no bundler or alternative loader was added.

### Version-aligned contracts and one-time release verification

Primary evidence is the official [Monaco 0.45.0 declaration](https://unpkg.com/monaco-editor@0.45.0/monaco.d.ts)
and the [pinned CDN AMD loader](https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/loader.js),
the same URL used by `public/index.html`. A one-time verification checked SHA-256
identities of both downloaded artifacts, then compiled consumed projections
against the unmodified API text (made module-local in a temporary directory,
removed afterward). The declaration hash was
`957cbcf34b58a4278c66e824c92e3b0a43b1e7b72567da9105e4faa6e3ae7b1b`;
the loader hash was
`effab18afbb4297a23d9d98be95672e4088c735a0677993c329cf29b48914aed`.
At the user's request, the temporary verification script and its mutation
controls are not retained as maintained project tooling. The results below are
historical implementation evidence, not a repeatable checked-in release gate.
Neither large API nor loader is vendored or installed as a dependency.

The compatibility checks cover string zone IDs; required position columns;
nullable model/selection projections; text-model line count, maximum column and
disposal; all four required diff-line coordinates (the unconsumed `charChanges`
field is not required of a fake); numeric `monaco.editor.MouseTargetType` values
and nullable mouse positions; required `layoutZone` and diff pane/navigation
methods; creation and consumed editor methods; precise word-wrap/diff-word-wrap
unions; and numeric `EditorOption.lineHeight = 66` lookup. Settings are checked
against both actual construction-option types. The application diff setter's
actual parameter tuple supplies the model-pair keys and values to a compiler-only
native-model projection. Its complete signature is compared with the official
setter restricted to the supplied pair (Monaco also accepts null/view models).
Consumed text models are **not** claimed to implement complete native
`ITextModel` objects.

`MonacoRuntime` describes the full **consumed** runtime projection separately
from `MonacoPort`/`DiffEditorPort`, which allow partial IO capabilities. Partial
code-editor capabilities retain receiver binding and fail only when exercised.
The test-only `fakeModel` likewise supplies guarded consumed methods, throwing
for unconfigured capabilities rather than pretending disposal alone provides
line geometry. Fakes claim neither broad Monaco classes nor native DOM classes.

The `unknown` mounting/view-zone node is deliberate at the CDN IO edge only:
public mount overloads still require native `HTMLElement` or structural viewer
nodes. The release check substitutes `HTMLElement` **only for those DOM fields**
when checking official creation/zone signatures; it does not assert an opaque
or fake node into a native element. Local static gates reject that substitution
by callers. The separate native ResizeObserver adapter retains its `instanceof
Element` check. No new external JSON/YAML boundary was introduced.

The native-substituted code-editor projection includes `changeViewZones`, not
just its other methods: the application callback's complete argument tuple and
return, and every application accessor method's arguments/returns, are compared
with the official consumed projection. Only the opaque DOM field is substituted;
the owner-required `heightInPx` remains required although Monaco additionally
accepts line-height zones. Full native-substituted diff/code-editor projections
are used for actual editor, pane and factory assignments.

The one-time verification also executed the exact pinned AMD loader in an isolated VM
with an in-memory success module and simulated script-load failure. This checks
the consumed `require.config`, module-array, success and error callback shape,
not real CDN transport, browser worker behavior or actual Monaco mounting.

### Automated implementation checks (Node 22.22.1)

- **Static:** regular `npm run typecheck` passes, accepting native browser and
  narrow partial IO controls and rejecting all **56** negative probes (41
  retained plus 15 Monaco/AMD probes). `npm run build` passes. The incremental
  zone-ID probe was red while numeric IDs were accepted, then green after making
  IDs strings and correcting fixture values. The official-declaration check was
  independently compiler-red for optional position columns, non-null models,
  broad wrap/mouse types and missing strict consumed model/runtime projections;
  it now passes. No blanket `any`, compiler suppression, fake-to-native cast or
  dependency installation was added.
- **Review follow-up red/green:** virtual application-contract mutations first
  exposed omissions in the original release probe: renaming the model-pair key
  or adding an unsupported callback argument was incorrectly accepted. After
  adding the complete native-substituted projections, the normal probe passes
  and all four temporary mutation controls produced failed compatibility assertions
  (TS2344): pair key, disposal-only pair value, callback arity and accessor
  argument. These controls alter compiler-host text only, never source files or
  fake models, and require a compatibility failure rather than a syntax error.
- **Integration:** the real `mountEditor`/`mountDiffEditor` owners over narrow
  Monaco/DOM/ResizeObserver fakes retain hunk navigation/recomputation, scrolling,
  one-shot autoscroll, zone topology/geometry/resizing, composer ranges,
  simulated focus and disposal coverage. New cases characterize bound partial
  receivers, unsupported/nullable model failures and null selection/mouse
  positions. The release enum lookup is explicitly asserted as numeric **66**.
- **AMD integration:** four new test registrations cover preloaded Monaco;
  exact pinned config/module loading; concurrent file/diff mount gating; fresh
  model identity and disposal; cached success including late error callbacks;
  missing loader, config/invocation throws and unknown module-error values;
  concurrent rejection and persistent rejected-cache behavior without retries.
  Known local ESM query identities isolate the real owner's module-lifetime
  cache without exposing a production reset hook. These characterize existing
  loading behavior, not a runtime retry fix.
- **Focused unit layer:** the seven existing range tests retain malformed and
  invalid-input coverage through their `unknown` validation boundary; the
  `clampLine` unit test remains. No tests or failure assertions were removed.

Focused compiled command after `npm run build`:

```sh
node --test dist/test/public/monaco-loader.test.js dist/test/public/monaco-view.test.js dist/test/public/comment-range.test.js dist/test/public/viewer.test.js dist/test/public/comments-flow.test.js dist/test/public/replies.test.js
```

This command passed **74 tests, 0 failed/skipped/cancelled**: 4 loader, 32 Monaco
owner, 7 range, 21 viewer, 1 comments-flow and 9 replies tests. The final static
and pinned-release compatibility checks passed, as did `git diff --check`.

### Independent validation and user manual evaluation

An independent check-only worker on Node **22.22.1** passed `npm run typecheck`,
one full `npm test` run (**598 compiled tests, 0 failed/skipped/cancelled**), the
pinned-release compatibility check including all four mutation controls, and
`git diff --check`.

The desktop browser was disconnected, so the primary agent did not operate or
observe a browser. Instead, the user evaluated the real editor served by
`npm run dev -- .` from this worktree at `http://localhost:4173` and explicitly
reported successful checks of:

- Layout in File, inline Diff and side-by-side Diff, including wrapping,
  resizing and comment alignment near EOF.
- Keyboard navigation, selection, composer/reply typing, Tab and returning focus.
- A fresh reload loading Monaco from the CDN without errors.
- IME composition in a comment or reply.

These are **user-reported manual results**, separate from automated tests; no
browser/OS/IME details or screenshots were collected. They are not exhaustive
cross-browser or accessibility evaluation. Automated simulated geometry/focus
and release type/loader compatibility alone do not establish native layout,
focus/IME, CDN transport, browser event fidelity, watcher reliability or
destructive Git safety. No real watcher/destructive Git evaluation, minimum-Node,
package/Git-install or build smoke rerun is claimed for this implementation.

## Latest-target integration validation (#78 and live observation/activity)

Replaying #78's `31ec55c` onto `origin/main` **`91f89dd`** retains the upstream
observation migration and all Monaco/AMD contracts and tests. Both evidence
sections above remain historical; this pass does not rerun the removed optional
pinned-release checker or restore it as project tooling. The auto-merged manifest
matches the source trees: **97 strict TS / 9 temporary JS inputs** (106 total),
including the new loader test, with the upstream 9-JS ceiling unchanged.

On Node **22.22.1**, `npm run typecheck` and `npm run build` passed. All **67
negative probes** (52 upstream plus 15 Monaco/AMD) reject their invalid inputs;
native browser/fetch/EventSource/editor/comment/watch/filesystem/timer, Monaco/AMD,
minimal path and structural watcher positive controls pass. One full `npm test`
run built and executed the explicit compiled manifest: **600 passed, 0 failed,
skipped or cancelled**. Working-tree and staged whitespace checks passed. No
behavioral integration issue was observed, and no dependencies changed.

No focused rerun was needed after the successful full suite. No smoke,
minimum-Node, browser/manual, real watcher or destructive Git evaluation was
rerun during this rebase. Earlier user-reported browser results remain separate;
simulated IO does not prove native layout/focus/IME, CDN/network reliability,
filesystem-event delivery, races or live Git safety.

## Implementation evidence and limitations for #74

Starting commit: `ac9e65d`. `app.ts`, `default-deps.ts` and their HTTP/discovery/
origin-main tests were already strict TypeScript. This slice migrates only the
two remaining server JavaScript inputs, `git` and `index`, retaining their `.js`
import specifiers and compiled executable path. The explicit manifest now has
**99 strict TS / 7 temporary JS inputs** (106 total), with a 7-JS ceiling.
No dependencies, engine minimum, loader, bundler, package layout or non-code
browser assets changed. The real Git adapter implements the existing narrow
arguments/working-directory/optional numeric `maxBuffer` port and returns text;
it does not expose arbitrary child-process encoding or execution options.
Existing unknown JSON/YAML validation and invalid-input cases remain unchanged.

### Agreed test plan and implementation checks (Node 22.22.1)

The pre-agreed seams remain static negative probes, real-module integration at
the public HTTP and origin/main boundaries over fake Git/watcher/filesystem/
timer capabilities, the retained thin pure-unit layer, and existing CLI/build/
package/Git-install smoke tooling. No private-function seam was added. Real
loopback HTTP is the explicit transport exception; some retained static-serving
cases also read compiled assets. This balance favors integration confidence over
new isolated implementation tests or live destructive Git operations.

- **Static, automated:** regular `npm run typecheck` passed, accepting the native
  Git adapter as `Git` and rejecting all **71 negative probes**. Four added probes
  reject non-string arguments, non-string working directory, non-numeric buffer
  limit and unsupported encoding on the real adapter. All four were accepted
  by the legacy JavaScript adapter (gate red), then rejected after migration
  (gate green). The CLI's strict build needed only a string annotation for its
  resolved repository root; no CLI behavioral/type-negative red is claimed.
- **Fixture red/green:** the byte-limit test first failed typecheck with TS2322
  because the existing request helper accepted only string bodies. Its honest
  `string | readonly Buffer[]` input then enabled typed byte writes without
  asserting fake objects into native HTTP classes.
- **Approved behavioral fix, integration red/green:** exactly **262144 UTF-8
  bytes** reached the mutation, but **262145 bytes** initially returned 500:
  early exit from body iteration detached `req.socket`, and subsequent protocol
  inspection threw. Work stopped for approval. The user explicitly approved
  fixing this within #74. Capturing protocol before awaiting the body preserves
  the existing limit and body rejection path, producing **400**, the existing
  `Invalid JSON body` envelope and `no-store`, without calling the mutation.
  The regression writes multibyte text in byte chunks (including a character
  split between client writes); it does not claim arbitrary TCP segmentation
  or request-abort/keep-alive coverage. No body draining or iterator behavior
  was otherwise changed.
- **Unit/integration, automated:** `npm run build` passed. Individual commands
  `node --test dist/test/server/app.test.js`,
  `node --test dist/test/server/handle-request.test.js`,
  `node --test dist/test/server/app.integration.test.js`,
  `node --test dist/test/server/origin-main.test.js` and
  `node --test dist/test/server/origin-main-live.test.js` passed **27 + 33 + 4 +
  2 + 4 = 70 tests**, zero failures/skips/cancellations. These retain HTTP headers,
  malformed JSON/origin/conflict checks, static-root/MIME/HEAD handling, all
  three SSE channels' disconnect cleanup, discovery selection/deletion labels
  and local origin/main cadence/ref-only/tag-shadow/missing-ref behavior. An
  additional HTTP characterization checks that unexpected dependency errors
  are logged but return only the existing generic 500 envelope and byte length.
- `git diff --check` passed. Separate new-file whitespace checks reported no
  whitespace diagnostics for `server/git.ts` or `server/index.ts` (`git diff
  --no-index --check /dev/null <file>` exits 1 because the new file differs).

### Final independent validation (Node 22.22.1 / npm 9.2.0)

- `npm run typecheck` passed with **99 TS / 7 JS inputs** and all **71 negative
  probes** rejected. One full `npm test` built and executed compiled output:
  **602 passed, zero failures**.
- `npm run smoke:build` passed, checking the compiled executable, mirrored
  static root, native `.js` imports and non-code browser assets over HTTP.
- `npm run smoke:package` passed with **57 tarball entries**, exercising the
  installed production CLI and static HTML/CSS/native ESM over loopback HTTP.
- `npm run smoke:git-install --
  git+file:///home/u130917/projects/issue-74-typed-server-composition#b4a67e0`
  passed against the committed implementation snapshot on the same Node/npm.
  Git-source prepare/pack and isolated production installation succeeded;
  the installed CLI, runtime and HTML/CSS/native ESM over HTTP were verified.
  The only subsequent change records this result in this document.
- Separate Standards and Spec reviews inspected the exact staged diff against
  `ac9e65d`; neither found an actionable finding. `git diff --cached --check`
  passed.

### Unperformed validation and remaining limits

Exact Node **20.19.0** was unavailable. The user explicitly chose validation on
installed Node **22.22.1** rather than downloading the minimum runtime. The
declared Node >=20.19.0 engine is unchanged, but minimum-runtime compatibility
remains **unverified**; passing on Node 22 is not evidence of passing on Node 20.

No manual/browser evaluation, real watcher evaluation or destructive Git action
was performed. Fake capabilities establish orchestration and simulated failure/
timing behavior, not actual filesystem event delivery, native Monaco layout/
focus/IME, network reliability, filesystem races or live Git safety. Aside from
the explicitly approved oversized-POST correction, runtime behavior is unchanged.

## Implementation evidence and limitations for #79

This section records the original #79 branch, before integrating #74.

Starting commit: `ac9e65d`. `workspace-ui` and its direct test now compile as
strict TypeScript, retaining native `.js` imports and the real
`DIFF_RENDER_MODES` import from `monaco-view`. The manifest contains **100 strict
TS / 7 temporary JS inputs** (107 total), with a lowered 7-JS ceiling. There are
no dependency changes, blanket `any`, compiler suppressions or unsafe assertions.

`workspace-dom` describes the consumed recursive element/document/window
operations, not full native classes. Queries are nullable and required controls
are checked before use. Native collections may be array-like or iterable;
HTML-only properties are optional on the general native Element projection.
The toolbar mounts its three children directly rather than requiring a fake
DocumentFragment. Outside-click handling uses the event's composed path, keeping
inside descendants and detached-listener cleanup at the same DOM IO seam.
The narrow fake retains class-only selectors and one listener per event, adding
attribute reads/data attributes and the consumed one-shot animation listener.

The integration fixture wires the real workspace, comparison locks, tree
expansion, view/auto-scroll/watch preferences and scroll-affordance helper, with
only DOM, fetch, storage and clock simulated. All **38 original control cases**
remain; six additional registrations cover per-worktree expansion/refetch,
deletion presentation/callbacks, actual preference clicks/persistence, branch
fallbacks/scroll/flashing, malformed resource JSON and malformed deletion metadata.
`deletionReason` is now validated as an optional string/null at the existing
unknown worktree-JSON boundary before presentation consumes it. Other JSON and
YAML validation remains with the real workspace and server validators; no trusted
YAML cast or replacement parser is introduced.

Automated worker evidence on **Node 22.22.1**:

- **Static:** `npm ci` installed existing locked dependencies and passed prepare;
  regular `npm run build` and `npm run typecheck` passed. Native Document/Window/
  Element and structural fake workspace-control positive probes pass. Six new
  negatives reject numeric comparison SHAs, nonboolean deletion state, nonnumeric
  edit times, unsupported diff modes, incompatible deletion callbacks and
  unchecked nullable queries: **73 negatives** overall. The native positive
  probe was initially compiler-red because HTMLCollection was incorrectly
  required to be iterable under this project's libraries; admitting its actual
  array-like capability made it green without assertions or library changes.
- **Red/green:** the expansion regression failed with the former constant/no-op
  expansion fixture (zero visible tree files after expansion), then passed with
  the real expansion store. The malformed deletion-metadata regression failed
  with missing expected rejection before that consumed field was validated,
  then passed after validation. Added deletion presentation and other existing-
  behavior characterizations are not claimed as unrelated runtime bug fixes.
- **Integration:** the direct compiled control test passed **44 tests**. Final
  focused compiled execution passed **212 tests, 0 failed/skipped/cancelled**, in
  `workspace-ui`, `workspace-state`, `app`, `worktree-delete`, `tree-state`,
  `collect-files`, `changed-files`, `comments-view`, `viewer` and `monaco-view`
  under `dist/test/public/`. This includes all retained malformed-input,
  stale-response, comparison-retention and app-level deletion failure cases.
  The app coordinator and its app/deletion tests remain unchecked JS compatibility
  coverage. Shared fake-DOM consumers are covered by this focused run.

Final independent check-only validation on **Node 22.22.1** passed
`npm run typecheck`, `npm test` (**606 passed, 0 failed/skipped**) and
`git diff --cached --check`. Standards and spec reviews inspected the complete
staged diff against starting commit `ac9e65d` and found no actionable findings.
No browser/manual evaluation, exact-minimum Node rerun, package/build/Git-install
smoke, real watcher or destructive Git evaluation was performed. Prior #78 user-
reported browser evidence is historical, not a new #79 check. Simulated controls,
events, storage and geometry establish orchestration and failure behavior, not
native layout/focus/IME, browser event fidelity, watcher reliability or live Git
deletion safety.

## Rebase integration validation (#74 and #79)

Replaying #79's `97509e6` onto fetched `origin/main` **`9dca86a`** retains both
the typed server composition and workspace-control migrations. The overlapping
documentation and static-probe expectations were combined, and the JavaScript
ceiling was lowered to 5. The explicit manifest matches **102 strict TS / 5
temporary JS inputs** (107 total), including `server/git.ts`, `server/index.ts`,
`public/workspace-dom.ts` and the migrated control owner/test. All server inputs
are strict TypeScript; the app coordinator and app-level deletion tests remain
unchecked compatibility coverage.

On **Node 22.22.1**, `npm run typecheck` passed with all **77 negative probes**
rejected (71 upstream plus six controls); native Git/browser and structural
control positive probes passed. One full `npm test` built and ran the explicit
compiled suite: **608 passed, 0 failed/skipped/cancelled**, retaining all **38
original + 6 additional control cases**, real workspace/preferences over fake
IO, and the real Monaco diff-mode import. The upstream oversized-POST protocol
fix and its HTTP regressions remain intact. No additional runtime behavior or
dependency changes were required for integration. `git diff --check` passed.

The per-issue validation above is historical, separate from this combined
snapshot. No minimum-Node, smoke/package/Git-install, browser/manual, real watcher
or destructive Git evaluation was rerun in this rebase. Simulated IO does not
prove native layout/focus/IME, network reliability, filesystem-event delivery,
races or live Git safety.
