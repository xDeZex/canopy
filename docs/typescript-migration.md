# Compiled execution and TypeScript migration

## Build boundary

`tsc` emits a disposable mirror: `server/`, `public/` and `test/` become
`dist/server/`, `dist/public/` and `dist/test/`. Each build deletes all old
output first, then copies non-code assets in those three trees. The server's
relative public-directory lookup and native browser `.js` imports are unchanged.
The executable is `dist/server/index.js`; npm packages include only the compiled
server/public trees (plus normal package metadata and README).

`tsconfig.json`'s **explicit `files` array is the migration manifest**, not a
broad include glob. The baseline had 94 JavaScript inputs. Issue #68 replaces
the routing helper and its unit test with strict TypeScript: 2 TS inputs and
92 remaining JS inputs. `allowJs: true` / `checkJs: false` only lets these
listed legacy modules pass through compilation; it does **not** make their
contracts type-safe. Build/typecheck/test gates compare the manifest against
all code in the three source trees, reject unlisted imported code, and enforce
a 92-JS ceiling. New code should be TypeScript and listed explicitly.

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
their own migrations. No external JSON/YAML runtime boundary is changed here.

## Reproducible checks

Use Node 20.19.0 to check the exact minimum, with its `bin` first on `PATH` so
npm and installed executable shebangs use the same Node version.

| Level | Command | What it proves |
| --- | --- | --- |
| Static, automated | `npm run typecheck` | Manifest coverage; strict migrated source/tests; four deliberately invalid helper calls rejected by the compiler |
| Unit/integration, automated | `npm test` | All explicitly selected compiled tests; existing fake IO boundaries are unchanged |
| Focused unit, automated | `node --test dist/test/server/route-logic.test.js` after `npm run build` | Existing containment and framing behavior plus newline escaping, snapshot passthrough and structural error regressions |
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
