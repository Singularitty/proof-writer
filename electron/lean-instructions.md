# Mechanizing a Proof Writer document in Lean

This folder is a Lean 4 project that mechanizes one document written in Proof
Writer, an editor for type systems and their metatheory. The Proof Writer app
owns this file and rewrites it; put your own conventions in `CONVENTIONS.md`,
which is imported at the end.

The app starts two kinds of job here, **sync** and **prove**, and tells you
which in the prompt. It then builds the project itself and decides from that
build, not from what you report, what is translated and what is proved. Your
report tells the author *why* things are as they are.

## The document

* `document.json` is a snapshot of the document. `document.md` is the same
  content, easier to read, with ids shown. Read `document.md` first and go to
  `document.json` for exact field contents.
* Math is LaTeX. Macros (`\ty{\Gamma}{e}{\tau}`) are defined under `snippets`
  in the JSON and listed at the top of the Markdown.
* Every block, rule, grammar row and case has an id. You refer to parts of
  the document by these ids, never by position or number.
* A **definition** is a grammar block, a rules block, or a statement of kind
  definition. A **statement** is a theorem, lemma, corollary, proposition or
  conjecture.

Never edit `document.json` or `document.md`. If the document should change,
propose it (see Reporting).

## Layout

```
lakefile.toml, lean-toolchain, PW.lean   project files; do not edit
PW/Defs.lean                             all definitions
PW/<Module>.lean                         one statement each; the prompt names the module
mechanization.json                       the app's records; do not edit
CLAUDE.md, CONVENTIONS.md                instructions; do not edit
```

* A statement's file imports `PW.Defs` and the modules of the statements its
  written proof cites. The prompt lists these.
* The project has no dependencies. Use core Lean and its standard library
  only. Do not add Mathlib, Batteries, Aesop or anything else to the lakefile.
* Write files in this folder only.

## Markers

Put a marker comment on its own line directly above every declaration that
comes from a block:

```lean
-- pw: <block id>
inductive HasType : Ctx → Tm → Ty → Prop where
  -- pw: <block id> <rule id>
  | app : HasType Γ e₁ (.arrow τ₁ τ₂) → HasType Γ e₂ τ₁ → HasType Γ (.app e₁ e₂) τ₂
```

* One marker per declaration; a block that becomes several declarations has
  the marker above each.
* A rule's constructor carries the block id and the rule id.
* In a statement's file, the marker goes above the theorem. Helper lemmas you
  need go below the marker too, so they count as part of that statement.
* Declarations that come from no block (a substitution function the document
  uses but never defines) go in `PW/Defs.lean` above the first marker that
  needs them, under the marker of the block that first uses them.

The app uses markers to tie build errors to blocks. A declaration without one
cannot be shown to the author.

## Translating definitions (sync)

* A grammar becomes one or more inductive types, one constructor per
  alternative, named after what the alternative is.
* A rules block becomes an inductive predicate, one constructor per rule. Name
  the constructor after the rule (`T-App` becomes `tApp` or `app`), and keep
  the premises in the document's order.
* A side condition becomes a hypothesis of its constructor.
* A definition statement becomes a `def`, an inductive predicate or an
  `abbrev`, whichever says what the prose says.
* Choose a representation for variables, binders and contexts once, record it
  in a comment at the top of `PW/Defs.lean`, and keep it. If `CONVENTIONS.md`
  names one, use that.
* Translate what is written. If a rule is wrong, translate it as written and
  report the problem; do not quietly repair it.

## Stating (sync)

* State every statement in its own file, saying what the text says: the same
  hypotheses, the same conclusion, the same quantifiers.
* Leave `sorry` as the proof of a statement that has no Lean proof yet. Keep
  an existing proof if it still compiles against the updated definitions; if
  it does not, replace it with `sorry` and report it as `stuck`.
* A hypothesis the text leaves implicit (a context being well formed, a
  variable being fresh) may be added only if you report it as a `deviation`.
* A conjecture is stated with `sorry` and never proved.

## Proving (prove)

* Edit only the file the prompt names. Do not edit `PW/Defs.lean` or another
  statement's file. If the proof cannot go through without that, stop, leave
  `sorry` where you are stuck, and report why.
* Follow the written proof: the same induction, on the same thing; the same
  case split; the same lemmas cited where the text cites them. One written
  case should be recognizable as one branch of the Lean proof.
* Use structured tactics (`induction … with`, `cases … with`, `rcases`,
  `obtain`) so that a failure sits in a named case. Avoid one-line automation
  that proves the whole statement and hides the argument.
* A case that does not go through as written is something the author needs to
  know. Report it as `stuck` with the case's id in `at`, or as an
  `inconsistency` if the written step relies on something another block
  contradicts. Do not route around it silently with a different argument.
* You may use a cited statement that is still `sorry`.

## What must not be done

* No `axiom`, ever.
* No `sorry` in `PW/Defs.lean`: a definition is complete or it is reported as `stuck`.
* No `sorry` or `admit` left in a proof you report as done.
* No weakening of a definition or a statement so that a proof goes through.
* No `unsafe`, no `implemented_by`, no changing options to silence errors.
* No commands other than `lake build` and `lake env lean <file>`.

These hold even where `CONVENTIONS.md` says otherwise.

## Checking

Run `lake build` before you finish and read its output. Fix what you can
within the rules above. What you cannot fix, report.

## Reporting

End every job with the report. Its fields:

* `outcome`: `done` if everything the job asked for builds, `partial` if some
  of it does, `failed` if none.
* `summary`: two or three sentences for the author.
* `blocks`: for each block you translated, its file and the Lean names
  declared for it.
* `changes`: each declaration you `added`, `changed` or `removed`.
* `findings`: one entry per thing the author should know. `block` is the id
  of the definition or statement it is about. Kinds:
  * `deviation`: the Lean text differs from the document, and how. Report one
    whenever you add a hypothesis, strengthen an induction hypothesis in a way
    that changes the statement, or pick one reading of ambiguous prose.
  * `inconsistency`: two blocks disagree. Put the others in `related`. For
    example, a proof case uses a rule in a way its premises do not allow, or
    a lemma is used with a context shape it is not stated for.
  * `stuck`: where and why a translation or proof stopped. Put the case id in
    `at` when it is one case, and the Lean position in `lean`. Quote Lean's
    error and say what it means for the written argument.
* `proposals`: concrete edits to the document that would fix a finding. Each
  changes one field. `before` must be the field's current text exactly, and
  `after` what it should become, in the document's own LaTeX and prose style.
  `target.field` is one of:
  * `statement`: a statement's text. `block` is the statement.
  * `text`: a text block's text. `block` is the text block.
  * `premise`: one premise of a rule. `block` is the rules block, `rule` the
    rule, `index` which premise (counting from 0). An index one past the last
    premise adds a premise; then `before` is empty.
  * `conclusion`: a rule's conclusion. `block` and `rule` as above.
  * `side`: a rule's side condition. `block` and `rule` as above; `before` is
    empty if it has none.
  * `alternative`: one alternative of a grammar production. `block` is the
    grammar, `row` the production, `index` which alternative.

  Propose only what you are confident is right; say why in `why`. The author
  accepts or dismisses each proposal. Nothing is applied for you.

Write messages for someone who knows their type system and not necessarily
Lean: "the case for T-App needs the context to be extended, but Lemma 2 only
allows weakening at the end" rather than a raw goal dump.

@CONVENTIONS.md
