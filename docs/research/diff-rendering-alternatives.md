# Diff rendering alternatives: is structural/AST diffing worth pursuing?

Follow-up research for issue #6 ("Explore alternative diff rendering"). The
toolbar-toggle part of #6 (Inline / Side-by-side / Collapsed, plus Monaco's
moved-block detection) shipped in PR #15. This document covers the one
question #6 left open: **is structural/AST diffing (difftastic-style) worth
pursuing as a follow-up**, specifically for reviewing AI-agent-written
refactors where line diffs get noisy from reformatting/renaming even when
the structural change is small.

Every claim below is cited to a primary source (vendor docs, source repos,
CHANGELOGs, man pages, or first-party issue trackers).

---

## 1. Structural/AST diffing mechanics

### difftastic

- **Algorithm**: difftastic's own README states it "treats structural
  diffing as a graph problem, and uses Dijkstra's algorithm" to find the
  shortest edit path over a graph of syntax-tree nodes.
  [github.com/Wilfred/difftastic](https://github.com/Wilfred/difftastic)
- **Language support**: parses with tree-sitter grammars; the README says
  difftastic "supports over 30 programming languages," pointing to
  [difftastic.wilfred.me.uk/languages_supported.html](https://difftastic.wilfred.me.uk/languages_supported.html)
  for the full list.
- **CLI invocation**: the `difft` man page ([mankier.com/1/difft](https://www.mankier.com/1/difft))
  documents a `--display` flag with values `side-by-side` (default),
  `side-by-side-show-both`, `inline`, and `json` ("Output the results as a
  machine-readable JSON array with an element per file"); also
  `--check-only` ("Report whether there are any changes, but don't
  calculate them. Much faster"), `--exit-code`, and
  `--parse-error-limit LIMIT` ("Use a line-oriented diff if the number of
  parse errors exceeds this value").
- **JSON output is explicitly unstable**, however: maintainer discussion on
  [github.com/Wilfred/difftastic/issues/916](https://github.com/Wilfred/difftastic/issues/916)
  ("[Feedback] JSON display mode schema") shows the mode requires
  `DFT_UNSTABLE=yes` to even enable, is JSONL/NDJSON rather than a single
  JSON document, and the maintainer says outright they don't know if
  anyone relies on it and is soliciting feedback on the schema before
  committing to stability.
- **Fallback behavior**: the README states plainly: "If a file has an
  unrecognised extension, difftastic uses a line-oriented diff with word
  highlighting," and separately, "By default, difftastic falls back to a
  line-oriented diff whenever parse errors are encountered." So both
  unsupported languages and malformed/partial code (exactly what an
  in-progress AI edit might look like mid-write) degrade gracefully to a
  line diff rather than erroring.
- **Distribution**: difftastic ships as prebuilt Rust binaries attached to
  GitHub releases for Linux (glibc and musl), macOS (x86-64 and ARM), and
  Windows — [github.com/Wilfred/difftastic/releases](https://github.com/Wilfred/difftastic/releases).
  No npm package or JS/WASM build is offered by the project itself.

### GumTree

- **Algorithm**: GumTree is an *edit-script / tree-matching* algorithm —
  conceptually different from difftastic's graph-shortest-path approach.
  Its README cites the original algorithm paper, Falleri et al.'s 2014
  "Fine-grained and accurate source code differencing," plus later
  refinements (Martinez et al. 2023 "Hyperparameter Optimization for AST
  Differencing"; Falleri & Martinez 2024 "Fine-grained, accurate and
  scalable source differencing"), and describes itself as ensuring "edit
  actions are always aligned with the syntax" and able to "detect moved or
  renamed elements." [github.com/GumTreeDiff/gumtree](https://github.com/GumTreeDiff/gumtree)
  This is the classic two-phase GumTree matching algorithm (top-down
  isomorphic subtree matching, then bottom-up container matching) rather
  than difftastic's shortest-path-over-a-diff-graph method — i.e. GumTree
  produces an explicit **edit script** (insert/delete/move/update
  operations on tree nodes) rather than an aligned side-by-side rendering.
- **Language support**: broad, with per-language parser backends of mixed
  maturity. Per the GumTree wiki's Languages page
  ([github.com/GumTreeDiff/gumtree/wiki/Languages](https://github.com/GumTreeDiff/gumtree/wiki/Languages)):
  Java (JDT backend, "stable"/default) and JavaParser as an alternative;
  CSS via phcss; and a long tail of languages — C, C++, C#, CMake, Go,
  Haskell, JavaScript, Kotlin, OCaml, PHP, Python, R, Ruby, Rust, Swift,
  TypeScript, TSX, YAML — backed by tree-sitter grammars, at "testing"
  maturity status rather than "stable." Several older non-tree-sitter
  backends (Acorn/Rhino for JS, ANTLR for PHP/XML, JRuby, pythonparser,
  Coccinelle for C) are marked retired/deprecated in favor of tree-sitter.
- **CLI invocation and output formats**: per the wiki's Commands page
  ([github.com/GumTreeDiff/gumtree/wiki/Commands](https://github.com/GumTreeDiff/gumtree/wiki/Commands)),
  GumTree offers several subcommands — `webdiff` (browser UI via a local
  server), `swingdiff` (desktop GUI), `htmldiff`, `textdiff`, and
  `dotdiff` (GraphViz). Critically, **`textdiff` documents a `-f`/format
  flag with `TEXT`, `XML`, and `JSON` as first-class, stably documented
  output formats** — unlike difftastic's JSON mode, this is not flagged
  unstable or gated behind an env var.
- **Fallback behavior**: the wiki's Getting-Started page notes several
  backends (srcML, Coccinelle, Parso, Acorn, tree-sitter) must be
  separately installed to enable support for their languages, but neither
  it nor the Languages page documents an automatic line-diff fallback for
  wholly unsupported languages or unparseable input the way difftastic
  does. This is a meaningful practical gap for a tool meant to run
  unattended against arbitrary in-progress agent edits.

**Conceptual difference worth noting**: difftastic finds a shortest edit
*path* over a graph of tree nodes and renders it as an aligned display
(text output, not a manipulable data structure); GumTree computes an
explicit edit *script* (structured insert/delete/move/update operations)
intended to be consumed programmatically (e.g. by refactoring-detection
tools) as much as rendered for a human to read. difftastic is closer to
"a nicer `git diff`"; GumTree is closer to "a diffing library with a CLI
wrapped around it."

---

## 2. Integration feasibility for Canopy specifically

Grounded in this repo's actual code (all paths relative to the worktree
root):

- **Backend** (`server/app.js`, `server/status.js`, `server/file-content.js`,
  `server/commits.js`, `server/porcelain.js`): a single `node:http`
  server with no framework, that shells out to `git` read-only via
  `execFile`/`promisify` (e.g. `git status --porcelain`, `git ls-files`,
  `git log`, `git worktree list --porcelain`) and serves plain JSON or SSE
  (`text/event-stream`) responses. There is no existing subprocess
  abstraction beyond `execFileAsync`, but adding one more `execFile` call
  (to a `difft` or `gumtree` binary) is a direct, idiomatic extension of
  what's already there — see e.g. the `getCommits` helper in `app.js`
  around line 103 for the exact pattern a new `getStructuralDiff` helper
  would follow.
- **Frontend** (`public/monaco-view.js`, `public/main.js`, `index.html`):
  Monaco is loaded via a classic AMD `<script>` tag from
  `cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs`
  (`monaco-view.js` line 23) — no bundler, no npm-installed frontend
  deps at all (`package.json`'s only dependency is `chokidar`, used
  server-side for the file watcher). `mountDiffEditor` in
  `monaco-view.js` wraps `monaco.editor.createDiffEditor` directly.

**Concretely, for each integration path:**

1. **Subprocess + pre-formatted text/HTML pane (difftastic)**: this is a
   *small addition*, consistent with Canopy's existing shape. The
   backend would `execFile('difft', ['--display', 'json', ...])` (or, more
   safely given its instability, `--display inline`/`side-by-side` and
   render the ANSI/plain-text output pre-formatted, or parse difftastic's
   line-oriented text output) and serve it over a new `/api/structural-diff`
   endpoint; the frontend would render the response in a `<pre>` or a
   read-only Monaco *plain editor* (not diff editor) pane, reusing
   `mountEditor` from `monaco-view.js`. No in-browser parsing, no
   bundler change. The new dependency is **a system binary the user must
   separately install** (difftastic has no npm package — confirmed above)
   — this is the one real friction point, since Canopy today has zero
   required system dependencies beyond `git` and Node itself.
2. **Subprocess + GumTree**: same shape, but GumTree distributes as a Java
   application (its wiki commands run through a Java `Run` class /
   packaged CLI), adding a **JVM dependency** on top of the binary-install
   friction difftastic already has — heavier than difftastic for the same
   integration pattern, with the compensating benefit of a stable,
   documented JSON output mode (`textdiff -f JSON`) rather than an
   explicitly-unstable one.
3. **In-browser WASM tree-sitter grammars**: this is a *new subsystem*,
   not a small addition — it would require bundling/loading per-language
   WASM grammar files, a JS tree-diffing implementation (neither
   difftastic nor GumTree ship a JS/WASM library; both are CLI tools
   around a Rust/JVM core), and per-language grammar management on the
   client. This directly conflicts with Canopy's stated no-build-step,
   CDN-only frontend approach (README: "single page, no build step to
   start") and would be the only path requiring a bundler to be
   introduced into the frontend at all.

**Summary judgment**: shelling out to a prebuilt `difft` (or `gumtree`)
binary and rendering its text output in a pane is a small, in-character
addition — one new `execFile` call plus one new static-rendering code
path, no bundler. The cost is entirely in the *installation* story (a
binary the user must have on `PATH`, which today Canopy doesn't require
of anyone) and, for difftastic specifically, in relying on an explicitly
unstable JSON contract if machine-readable output is wanted rather than
scraping formatted text.

---

## 3. Other real-world diff-rendering approaches

- **GitHub — rich diffs for non-code files**: GitHub's own docs
  ("Working with non-code files,"
  [docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files))
  describe rendered/visual diffing for image formats (PNG, JPG, GIF, SVG,
  etc.) with **2-up, swipe, and onion-skin** comparison modes, and note
  dimension-change display when an image is resized. This is structurally
  distinct from anything Canopy does today — it's format-aware rendering
  for binary/visual content, not text diffing at all, and would only be
  relevant to Canopy if agent-written changes ever touch images/assets.
- **GitLab — inline suggestion-apply UI**: GitLab's merge-request-review
  docs ([docs.gitlab.com/user/project/merge_requests/reviews/suggestions](https://docs.gitlab.com/user/project/merge_requests/reviews/suggestions/))
  describe reviewers writing a suggested replacement directly in a diff
  comment, which the author (or the reviewer, if permitted) can then
  "Apply suggestion" to create a commit automatically, including batching
  multiple suggestions into one commit. This is orthogonal to
  *rendering* — it's a diff-review workflow feature (accept/apply) rather
  than a different diff algorithm — but worth flagging since Canopy is a
  review tool: an "apply this hunk" affordance is a different kind of
  follow-up from structural diffing.
- **Sourcegraph — code-intel-powered diffs and Diff Tour**: Sourcegraph's
  docs describe hover-based code intelligence (go-to-definition, hover
  signatures) available directly inside a diff view, and a separate "Diff
  Tour" feature that turns a large diff into a guided, sectioned reading
  path with generated explanations
  ([sourcegraph.com/docs/diff-tour](https://sourcegraph.com/docs/diff-tour)).
  Diff Tour in particular is conceptually adjacent to Canopy's problem
  (noisy large diffs from automated changes) but solves it by
  *summarizing/sequencing* the diff rather than by structurally
  re-diffing it — a lighter-weight alternative worth keeping in mind.
- **JetBrains IDEs — no shipped semantic diff**: despite being a mature
  commercial IDE line, JetBrains has **no built-in semantic/structure-aware
  diff**, and this is a longstanding, still-open user request, not a
  documented feature. Multiple open YouTrack issues confirm this directly:
  "Make diff tool SMART, semantic, structure aware" (IJPL-99523),
  "Semantic Diffing/Merging" (IJPL-103251, IDEA-147445), and a request to
  add Bram Cohen's patience-diff algorithm (IDEA-108369) that also remains
  open. This is useful negative evidence: even a well-resourced commercial
  IDE vendor has not shipped this despite years of user demand, which
  should temper expectations about how straightforward "good" structural
  diffing is to productionize.
- **Beyond Compare — rules-based comparison**: Scooter Software's own docs
  ([scootersoftware.com/v4help/rules_vs_file_formats.html](https://www.scootersoftware.com/v4help/rules_vs_file_formats.html))
  describe a two-layer system: "File Formats" parse a file's syntax into
  elements, and session "Rules" mark which elements matter, letting Beyond
  Compare "distinguish between significant code changes and
  formatting-only modifications based on the file's syntax structure."
  This is a real, shipped, commercial analog to what issue #6 is asking
  about — a mainstream tool doing syntax-aware (not full AST-edit-script)
  structural comparison specifically to suppress reformatting noise.
- **Meld — no semantic diff feature**: Meld's own features page
  (meldmerge.org/features.html) and man page describe two/three-way text
  and directory diff/merge with regex-based text filtering, real-time
  highlighting, and VCS integration, but **no semantic or structural
  diffing** is documented anywhere in its feature set — another data
  point that this capability is not standard even among long-established
  open-source diff/merge tools.

---

## 4. Monaco's own diff algorithm limitations

Canopy's entire diff view already depends on Monaco's diff editor
(`monaco.editor.createDiffEditor`, `public/monaco-view.js`), so this
grounds what Canopy has today versus what structural diffing would add on
top.

- **`legacy` vs `advanced`**: Monaco/VS Code's `diffEditor.diffAlgorithm`
  setting takes `"legacy"` or `"advanced"` (naming fixed in the 0.38.0
  Monaco release, per
  [github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md](https://github.com/microsoft/monaco-editor/blob/main/CHANGELOG.md):
  "`diffAlgorithm` values changed: `smart` -> `legacy`, `experimental` ->
  `advanced`"). VS Code's own release notes for 1.78
  ([code.visualstudio.com/updates/v1_78](https://code.visualstudio.com/updates/v1_78))
  describe what `advanced` actually changed: better indentation-aware
  line-insertion diffs, better word-level diffs around separator
  characters, diffs that minimize total diff length and chunk count
  ("more natural diffs"), and character-level diffs extended to whole
  words when a meaningful part of the word changed. The 1.81 notes add
  that heuristics were tightened "to reduce the probability of matching
  unrelated words," and that `advanced` became the default in that
  release. Later Monaco releases add `advanced-external` and
  `advanced-wasm` variants (CHANGELOG 0.56.0).
- **Known limitation — performance/hangs on large inputs**: VS Code issue
  [#216953](https://github.com/microsoft/vscode/issues/216953)
  ("Fallback on 'legacy' diff algorithm if 'advanced' is too slow")
  documents the advanced algorithm taking 30+ seconds or effectively
  hanging on a 15,000-line file, with the reporter noting that when a time
  limit is hit "the editor displays files side-by-side without any
  highlighting of differences" and there's no automatic fallback to
  `legacy`. This is an open, backlog-tagged bug, not a resolved one.
- **`hideUnchangedRegions` has its own open bug**: separately from the
  algorithm choice, [microsoft/monaco-editor#4196](https://github.com/microsoft/monaco-editor/issues/4196)
  reports that `hideUnchangedRegions` (the option backing Canopy's new
  "Collapsed" mode from PR #15) does not reliably fold unchanged regions
  in the standalone `monaco-editor` package the way it does inside VS
  Code proper, despite passing the documented options
  (`enabled`, `revealLineCount`, `minimumLineCount`, `contextLineCount`).
  Worth a manual smoke-test in Canopy given it's now user-facing.

**Bottom line**: Monaco's "advanced" algorithm is still fundamentally a
line/word/character-level diff with alignment heuristics — none of the
described improvements (indentation-aware insertions, word-boundary
matching, chunk minimization) operate on parsed syntax. It narrows the
gap with structural diffing for common reformatting cases (e.g. adding a
trailing comma bumping every line's indentation) but does not close it
for anything requiring actual syntax awareness (e.g. a renamed variable
used across a reordered set of statements) — the same class of noise
issue #6 was originally raised about.

---

## Recommendation: scope it as a follow-up issue, don't build it now

**Do not implement structural diffing now.** Scope it as a follow-up
GitHub issue with a narrow, concrete acceptance bar, gated on evidence
from actually using Canopy's existing (PR #15) toggle first.

**Reasoning, weighed against the specific use case (reviewing AI-agent
refactors, not diff review in general):**

- **Effort is real, not trivial, even taking the cheapest path.** The
  cheapest integration (shell out to `difft`, render text) is small in
  *code* terms (one `execFile` call, one static-text pane — Section 2),
  but it introduces Canopy's *first-ever* required system binary the user
  must install outside of `git`/Node, for a tool whose whole pitch today
  is "a small local Node process" with no such requirements. difftastic
  has no npm package (confirmed via its own releases page), so there's no
  way to make this a `package.json` dependency the way `chokidar` is —
  every user of Canopy would need a manual install step for a feature
  that only fires occasionally.
- **The dependency's own maintainer signals its machine-readable output
  isn't ready to build on.** difftastic's JSON mode is gated behind
  `DFT_UNSTABLE=yes`, and the maintainer's own words in issue #916 are
  that they don't know if anyone relies on it. Building Canopy's UI
  against that contract risks churn; falling back to scraping
  difftastic's human-oriented text/ANSI output is more stable but means
  Canopy owns more rendering logic for less structured data. (GumTree's
  `textdiff -f JSON` is stably documented, which tips the technical
  choice toward GumTree *if* this is pursued — but GumTree adds a JVM
  dependency on top of the binary-install friction difftastic already
  has, which is a heavier ask of the user, not a lighter one.)
- **Monaco's advanced algorithm already absorbs a meaningful slice of the
  motivating pain for free.** Section 4 shows `advanced` specifically
  targets indentation-driven reformatting noise and word-level rename
  noise — exactly the kind of churn "a reformatted or lightly-refactored
  block" produces — and it's already what Canopy uses. The residual gap
  structural diffing would close is narrower than issue #6 originally
  assumed: it's specifically deep syntax-tree-level restructuring (e.g.
  reordered statements, extracted functions) that word/line heuristics
  can't paper over, not general reformatting noise.
- **No mainstream tool has this solved cheaply.** Section 3's survey is a
  consistent signal: JetBrains doesn't ship it despite years of open
  feature requests from a large user base; Meld doesn't have it either.
  Only Beyond Compare (commercial, GUI desktop app) ships something
  comparable, via its own bespoke rules/file-format engine, not a
  standalone open-source diffing tool. That raises real doubt about how
  much day-to-day value a first cut would deliver relative to its
  install-friction cost, versus waiting for evidence of real pain.

**If scoped as a follow-up issue**, sketch:

- **Title**: "Explore structural (AST) diff as an opt-in pane, using
  difftastic"
- **Body**: Frame it explicitly as gated on user-reported pain with the
  PR #15 toggle — i.e. only pick this up after Canopy has been used
  against a handful of real AI-agent refactor sessions and reformatting
  noise still shows up as a recurring complaint despite `advanced` +
  Collapsed mode. Note the two viable integration shapes from Section 2
  (difftastic via `execFile` + text pane; GumTree via `execFile` + JSON)
  and that WASM-in-browser tree-sitter is out of scope (conflicts with
  the no-build-step frontend).
- **Acceptance criteria** (draft):
  1. A new opt-in toolbar mode, e.g. "Structural" alongside
     Inline/Side-by-side/Collapsed, only enabled when the configured
     binary is found on `PATH` at startup (no hard runtime dependency
     added for users who don't have it).
  2. Backend: `execFile`s the binary read-only against HEAD vs working
     content for the active file (same content Canopy already fetches in
     `server/file-content.js`), with a documented, explicit fallback to
     the existing Monaco diff view for unsupported languages, parse
     errors, or a missing/failed binary — must never be a dead end.
  3. Frontend: renders the tool's text/JSON output in a read-only pane;
     no new frontend build tooling introduced.
  4. Explicitly out of scope: bundling or auto-installing the binary,
     in-browser WASM parsing, and supporting every language difftastic
     or GumTree support — start with whatever subset covers Canopy's own
     dogfooding languages (JS/TS given Canopy's own codebase).
