# Lean mechanization through Claude Code

Date: 2026-10-12. Status: awaiting review.

## Purpose

While a document is written in the desktop app, Claude Code keeps a Lean 4
development in step with it. Definitions are translated when the user syncs;
a statement's proof is mechanized when the user asks for it. When Lean rejects
something, the user is told which block of the document is at fault, how the
Lean text deviates from the document, and what Claude changed.

Decisions taken with the user:

* Driven from inside the desktop app, not from a terminal session.
* The app launches the `claude` CLI headless (no SDK, no API key in the app).
* Claude writes Lean files only. Changes to the document are *proposed* and
  the user accepts or dismisses each one.
* Definitions are marked out of date when their blocks change and are
  re-translated on a click, and automatically before a proof request.
* Plain Lean 4 with no dependencies; the app guides the user through
  installing the toolchain.
* The standing instructions for the agent live in a Markdown file in the Lean
  folder, not in a prompt buried in the app.
* Lean, not Rocq, for now. Prover-specific code is kept in one place on each
  side of the process boundary, but no second backend is built.

Out of scope: the browser build (it shows nothing new), Mathlib, a Rocq
backend, changes to `mod/proof-tracker`, running jobs for several documents
at once in one window.

## What the user sees

### The Lean tab

A fifth sidebar tab, **Lean**, present only in the desktop app. From the top:

1. **Setup state.** One of:
   * the document has no file: "Save the document to a file to mechanize it";
   * `claude` or `lake` was not found: what is missing, the command that
     installs it (`curl https://elan.lean-lang.org/elan-init.sh -sSf | sh`
     on macOS and Linux, the elan installer link on Windows) and a
     **Check again** button;
   * ready: the Lean folder's path with a reveal-in-file-manager link.
2. **Sync definitions** button, with a count of out-of-date blocks, and
   beside it the **Model** and **Effort** selectors (below).
3. **The running job**, when there is one: what it is doing ("Proving
   Lemma 2"), the last few lines of activity (the files Claude writes, the
   builds it runs), and **Cancel**.
4. **Definitions**: one row per grammar block, rules block and `definition`
   statement.
5. **Statements**: one row per theorem, lemma, corollary and proposition, in
   document order. A row with a proof block has a **Prove** button (**Prove
   again** once it has been attempted). Conjectures are stated but have no
   Prove button.
6. **Last job's changes**: the Lean declarations added, changed and removed.

Each row has a status dot, the block's name as the Tracker shows it, and jumps
to the block on click. Findings and proposals for a block are listed under its
row.

### Model and effort

Two dropdowns choose what the next job runs with:

* **Model**: Default, Fable, Opus, Sonnet, Haiku. These are the CLI's aliases,
  so each follows the latest model of that name without an app update.
* **Effort**: Default, Low, Medium, High, Extra high, Max.

Default passes nothing and leaves the choice to the user's Claude Code
settings. The selection is a preference of the app, kept across documents and
restarts, not part of the document or the Lean folder. It applies to the sync
that runs ahead of a proof as well as to the proof. The selectors are disabled
while a job runs, and the running job's line names what it runs with ("Proving
Lemma 2 · Opus, high"). If the CLI rejects the choice (a model the account
cannot use), the job fails with the CLI's message like any other failed run.

### Statuses

| Status | Meaning |
| --- | --- |
| Not translated | No Lean counterpart yet. |
| Out of date | The block changed since it was translated, or a definition changed since the last sync. |
| Translated | (definitions) Compiles. |
| Stated | (statements) The Lean statement compiles; its proof is `sorry`. |
| Proved | Builds, and neither the statement's file nor anything it depends on contains `sorry` or declares an `axiom`, other than `sorry` in statements it cites (see below). |
| Proved with deviations | As Proved, but a deviation is recorded for it. |
| Failed | The last job for this block ended without a compiling result. |

A proof may cite a lemma that is itself only Stated. The row then reads
"Proved, assuming Lemma 3", and becomes Proved when Lemma 3 is.

If the prose proof changes after the statement was proved, the Lean proof is
still a proof of the same statement, so the status stays and the row adds
"the written proof has changed since".

### In the editor

Each theorem block's header shows the same status dot with a tooltip, and
clicking it opens the Lean tab at that row.

### Findings

A job ends with findings, each attached to a block (and to a case of a case
analysis when it concerns one):

* **Deviation**: where the Lean text differs from the document and why
  ("Lean needs Γ to be well-formed as an extra hypothesis").
* **Inconsistency**: a conflict between blocks, naming both ("case T-App uses
  weakening with a reordered context; Lemma 2 is stated for extension only").
  It is listed under each block it names.
* **Stuck**: where a proof stopped, with Lean's error message and Claude's
  reading of it.

### Proposals

A proposal is a concrete edit to one field of the document, shown as before
and after with the reason, and **Accept** and **Dismiss** buttons. The fields
a proposal may target:

* a statement's text;
* a rule's premise (by index; an index one past the end adds a premise), its
  conclusion or its side condition;
* one alternative of a grammar production;
* a text block's text.

Accept applies the edit as a single undo step, and only if the field still
holds the "before" text; otherwise the proposal is shown as no longer
applicable. Accepting an edit makes the block out of date like any other edit.
Dismissed proposals are remembered and not shown again.

## The Lean project

For a document `stlc.proof.json` the folder is `stlc-lean/` beside it (the
document's file name without its extensions, plus `-lean`). It is an ordinary
Lake project that can be opened in an editor:

```
stlc-lean/
  lakefile.toml         one library, PW, no dependencies
  lean-toolchain        the toolchain found when the folder was created
  PW.lean               imports every module below
  PW/Defs.lean          syntax, judgments, rules, definitions
  PW/<Label>.lean       one per statement: its Lean statement and proof
  CLAUDE.md             instructions for the agent; owned by the app
  CONVENTIONS.md        the user's own instructions; never overwritten
  document.json         read-only snapshot of the document for the running job
  document.md           the same in the prose export, for reading
  mechanization.json    the status file
  .gitignore            .lake/
```

`<Label>` is the statement's label made into a Lean module name
(`lem:canonical` → `LemCanonical`); a statement without a label uses its block
id. A statement's file imports `PW.Defs` and the files of the statements its
proof cites, which the checker already computes. A citation cycle is already a
checker error; statements in a cycle are not stated and say so.

Every declaration that comes from a block is preceded by a marker comment,
`-- pw: <block id>` (rules add `-- pw: <block id> <rule id>` on their
constructor). The app uses the markers to attribute a build error to a block:
the error belongs to the nearest marker above its line.

## Instructions for the agent

`CLAUDE.md` in the Lean folder tells the agent what this folder is and how to
work in it. Claude Code reads it on its own, so it applies to the jobs the app
starts and equally to a session the user opens in that folder by hand. It is
the single place the rules are written; the prompt of a job only names the job.

Its text is kept in the repository as `electron/lean-instructions.md`, shipped
with the app, and written to the Lean folder when the folder is created and
again before each job, so an updated app updates it. It covers:

* **What this is**: a mechanization of the document in `document.json`
  (`document.md` to read), and how blocks, labels and rule names there map to
  files and declarations here.
* **Layout and markers**: the files above, the `-- pw:` marker before every
  declaration, module naming, what imports what.
* **Translating definitions**: a grammar becomes an inductive type, a rules
  block an inductive predicate with one constructor per rule named after it,
  a side condition a hypothesis of its constructor; how to choose a
  representation for binders and contexts, and to keep that choice once made.
* **Stating**: a statement says what the text says. Hypotheses the text leaves
  implicit may be added only when reported as a deviation.
* **Proving**: follow the written proof's induction, cases and cited lemmas; a
  case that does not go through as written is a finding, not something to
  route around silently.
* **What must not be done**: no `axiom`, no `sorry` left in a proof reported
  as done, no weakening a definition or statement to make a proof pass, no
  writing outside this folder, no editing `document.json`,
  `mechanization.json` or `CLAUDE.md`, and during a proof no editing
  `Defs.lean` or another statement's file.
* **Checking**: build with `lake build` before finishing; the app builds again
  and its result is what counts.
* **Reporting**: what a deviation, an inconsistency, a stuck proof and a
  proposal are, when each is called for, and the fields a proposal may target.

`CLAUDE.md` ends by importing `CONVENTIONS.md`. That file is created once with
a short explanation and is the user's to edit ("use de Bruijn indices",
"contexts are lists, newest binding first"); the app never rewrites it. Where
the two disagree, the prohibitions in `CLAUDE.md` win, and it says so.

## The two jobs

Both run the same way (next section) and follow the instructions above. A
job's prompt is short: which job, which block, and what changed.

**Sync definitions.** Input: the snapshot, the list of blocks that are new,
changed or deleted since the last sync, and the existing Lean files. Claude
brings `Defs.lean` up to date and writes or updates the *statement* of every
theorem, lemma, corollary, proposition and conjecture, leaving existing proofs
in place where they still compile and replacing them with `sorry` where they
do not. It may not weaken a definition to make something compile; where it
must depart from the text it reports a deviation.

**Prove.** Input: the snapshot and the statement's block id. If any
definition or statement is out of date, a sync runs first, and the proof is
not attempted if the sync fails. Claude replaces the `sorry` in that
statement's file, following the structure of the written proof (the same
induction, the same cases, the same lemmas cited). It may not edit `Defs.lean`
or another statement's file; if the proof cannot go through without that, it
stops and reports why, with a proposal where a document change would fix it.

One job runs at a time per window. Cancel kills the process; the Lean files
are left as they are, and the build that follows decides the statuses.

## Running Claude

The Electron main process spawns
`claude -p --output-format stream-json --json-schema <report schema>` with the
Lean folder as its working directory and the job's prompt on stdin, adding
`--model <alias>` and `--effort <level>` when the selectors are not on
Default. The main process accepts only the values listed above for these.

* **Tools**: Read, Edit, Write, Glob, Grep, and Bash limited to `lake build`
  and `lake env lean <file>`. Anything else is refused, not prompted for.
* **Isolation**: the run does not load the user's plugins, hooks or MCP
  servers, so a job behaves the same on every machine. It uses the user's
  existing Claude Code login. The Lean folder's `CLAUDE.md` must still be
  loaded; if the flags that give the isolation also skip it, the app passes
  the file explicitly.
* **Confinement**: file tools reach the Lean folder only. The document itself
  lies outside it; Claude reads the snapshot.
* **Finding the binaries**: a packaged macOS or Linux app does not inherit the
  shell's PATH, so `claude` and `lake` are looked for on PATH and then in
  `~/.local/bin`, `~/.claude/local`, `~/.elan/bin` and the npm global bin
  directory (`.cmd`/`.exe` on Windows).
* **Progress**: tool-use events from the stream become activity lines ("wrote
  PW/Defs.lean", "lake build: 2 errors").
* **Limit**: a job is stopped after 30 minutes.

The exact flags for the tool limits and the isolation are to be confirmed
against the installed CLI when the plan is written; the requirements above are
what the spec fixes.

### The report

The final structured output of a run, validated against a JSON schema:

```ts
interface JobReport {
  outcome: 'done' | 'partial' | 'failed';
  summary: string;
  /** Lean declarations that came from each block. */
  blocks: { block: Id; file: string; names: string[] }[];
  findings: {
    kind: 'deviation' | 'inconsistency' | 'stuck';
    block: Id;
    at?: Id;              // a case of a case analysis
    related?: Id[];       // other blocks an inconsistency involves
    message: string;
    lean?: { file: string; line: number };
  }[];
  proposals: {
    block: Id;
    target:
      | { field: 'statement' } | { field: 'text' }
      | { field: 'premise'; rule: Id; index: number }
      | { field: 'conclusion'; rule: Id } | { field: 'side'; rule: Id }
      | { field: 'alternative'; row: Id; index: number };
    before: string;
    after: string;
    why: string;
  }[];
  changes: { file: string; name: string; change: 'added' | 'changed' | 'removed' }[];
}
```

Findings and proposals that name a block the document does not have are
dropped. A run that ends without a valid report (crash, cancel, time limit) is
treated as `failed` with no findings beyond what the build shows.

## The app decides what is proved

Nothing in the report sets a status. After every job, whatever its outcome,
the main process:

1. runs `lake build` and parses its diagnostics into
   `{ file, line, column, severity, message }`;
2. scans each `PW/*.lean` file for `sorry` and for `axiom` declarations,
   outside comments and strings, and reads `declaration uses 'sorry'`
   warnings from the build.

From these and the markers the app derives each block's status. Build errors
attributed to a block are shown under it as Stuck findings even if the report
did not mention them. An `axiom` anywhere makes every statement that depends
on that file Failed, with the axiom named.

## Staleness

Each block's hash is taken when it is translated and stored in the status
file. The hash covers the block's content that carries meaning (for a rules
block: judgment form and each rule's name, premises, conclusion and side
condition; for a grammar: its rows; for a statement: kind, label and statement
text) together with the bodies of the snippets it uses, so editing a macro
marks its users. Titles, captions and collapsed state are not hashed.

* A definition block whose hash differs, or that is new or deleted: it is Out
  of date, and so is every statement, until the next sync. The build after
  that sync decides which proofs survived; there is no dependency tracking
  beyond that.
* A statement whose hash differs: it is Out of date.
* A statement's proof block is hashed separately and only produces the "the
  written proof has changed since" note.

## The status file

`mechanization.json` is written only by the app, atomically (write to a
temporary file, rename):

```ts
interface Mechanization {
  version: 1;
  blocks: Record<Id, {
    hash: string;
    proofHash?: string;
    file: string;
    names: string[];
    status: 'translated' | 'stated' | 'proved' | 'failed';
    assumes?: Id[];       // cited statements still unproved
    findings: JobReport['findings'];
  }>;
  proposals: (JobReport['proposals'][number] & { id: string; state: 'open' | 'dismissed' | 'accepted' })[];
  lastJob?: { kind: 'sync' | 'prove'; target?: Id; endedAt: string; model?: string; effort?: string; outcome: JobReport['outcome'] | 'cancelled'; summary: string; changes: JobReport['changes'] };
}
```

"Not translated" and "Out of date" are not stored; they follow from comparing
the file with the open document. A missing or unreadable file is an empty one.

## Code layout

Renderer, pure TypeScript with no DOM, tested with vitest:

* `src/lean/hash.ts`: block hashes and what is out of date.
* `src/lean/status.ts`: the types above, reading and validating
  `mechanization.json` and a `JobReport`, and deriving statuses from a build
  result, a scan and the markers.
* `src/lean/proposals.ts`: whether a proposal still applies, and applying it.
* `src/lean/prompt.ts`: the two job prompts and the report schema. Together
  with the instructions file and the main-process module below this is all
  the prover-specific code.
* `src/lean/view.ts`: the rows the tab shows, as `check/view.ts` does for the
  Tracker.

Renderer, UI:

* `src/components/Lean.tsx`: the tab. `Sidebar.tsx` gains the tab,
  `Blocks.tsx` the status dot on theorem blocks.
* `src/store.ts`: the mechanization state of the open document and the running
  job; applying a proposal goes through the existing undo. The model and
  effort preference is kept in localStorage as the view preferences are.
* `src/util/desktop.ts`: the bridge's new `lean` group.

Main process:

* `electron/lean.cjs`: finding `claude` and `lake`, creating the Lake project,
  writing the snapshot, spawning and cancelling a run and turning its stream
  into progress events, running `lake build` and parsing its output, the
  `sorry`/`axiom` scan, reading and writing the status file, and writing
  `CLAUDE.md` (always) and `CONVENTIONS.md` (once). Every path is
  checked to lie inside the Lean folder of the window's document.
* `electron/lean-instructions.md`: the text of `CLAUDE.md`.
* `electron/main.cjs` and `preload.cjs`: IPC for the above:
  `lean.tools()`, `lean.open(docPath)`, `lean.run({ docPath, prompt,
  snapshot, model, effort })`, `lean.cancel()`, `lean.build(docPath)`,
  `lean.writeStatus(docPath, status)`, `lean.reveal(docPath)` and an
  `onLeanEvent` subscription.

The renderer orchestrates a job: compute what is out of date, build the
prompt, ask main to run Claude, ask main to build and scan, derive the
statuses, ask main to write the status file. If the window closes mid-job
nothing is recorded, and the affected blocks stay out of date.

## Errors

| Situation | What happens |
| --- | --- |
| `claude` or `lake` missing | The tab shows setup instructions; no buttons. |
| `claude` not logged in, or the run exits non-zero | The job fails with the CLI's message shown in the tab. |
| Report missing or invalid | Job `failed`; statuses still come from the build. |
| `lake build` cannot start (broken project) | Shown in the tab with the output; a **Recreate project files** action rewrites `lakefile.toml`, `lean-toolchain` and `PW.lean` and leaves `PW/` alone. |
| Document edited while a job runs | The job ran against its snapshot. Hashes recorded are the snapshot's, so blocks edited meanwhile show as out of date. |
| Document file moved or renamed | The Lean folder is looked for beside the new name; none there means starting over. Moving the folder along is left to the user and described in the guide. |

## Testing

* Unit tests for hashing and staleness, validating the status file and the
  report, deriving statuses (including "assuming Lemma 3" and the axiom case),
  marker attribution, proposals, the build-output parser and the
  `sorry`/`axiom` scan.
* `electron/lean.cjs` is tested as `watch.cjs` and `workspace.cjs` are, with
  stand-in `claude` and `lake` scripts on the PATH that emit a recorded stream
  and build output: a successful sync, a failed proof, a cancelled run, a run
  with no report, and that the chosen model and effort reach the command line
  and an unlisted value is refused. Also that `CLAUDE.md` is rewritten before a job and an edited
  `CONVENTIONS.md` is left alone.
* A test that the report schema and the instructions file agree: every
  finding kind and proposal field in the schema is named in the instructions.
* One manual end-to-end pass on the sample document (simply typed
  λ-calculus) once Lean is installed: sync, prove Progress, break a rule and
  see the proof go out of date and fail with the rule named.

## Documentation

A "Mechanizing in Lean" section in `docs/guide.md` (setup, the tab, statuses,
what Claude may and may not change, where the Lean files are) and a bullet and
source-layout entries in `README.md`.
