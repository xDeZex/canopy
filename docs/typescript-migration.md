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
and 87 remaining JS inputs**. `allowJs: true` / `checkJs: false` only lets these
listed legacy modules pass through compilation; it does **not** make their
contracts type-safe. Build/typecheck/test gates compare the manifest against
all code in the three source trees, reject unlisted imported code, and enforce
an 87-JS ceiling. New code should be TypeScript and listed explicitly.

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
| Static, automated | `npm run typecheck` | Manifest coverage; strict migrated source/tests; eleven deliberately invalid routing/HTTP calls and response shapes rejected by the compiler |
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
