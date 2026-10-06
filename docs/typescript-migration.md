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
`allowJs: true` / `checkJs: false` only lets these
listed legacy modules pass through compilation; it does **not** make their
contracts type-safe. Build/typecheck/test gates compare the manifest against
all code in the three source trees, reject unlisted imported code, and enforce
a 43-JS ceiling. New code should be TypeScript and listed explicitly.

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
| Static, automated | `npm run typecheck` | Manifest coverage; strict migrated source/tests; native browser ports accepted; nineteen invalid routing/HTTP/discovery/Git/commit/confirmation calls, response shapes, fake DOM capabilities and a range-less file anchor rejected |
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
