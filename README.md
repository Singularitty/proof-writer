# Proof Writer

A browser app for writing type system definitions, inference rules, proof trees,
lemmas and soundness proofs in one place, with a live PDF preview and export to
both **Typst** and **LaTeX**.

Everything runs in the browser: the Typst compiler is bundled as WebAssembly, so
the preview needs no server and works offline once loaded. Documents are saved
in the browser's local storage automatically; use **Save .json** to back them up.

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
```

`npm run build` produces a static site in `dist/` that can be hosted anywhere
(GitHub Pages, Netlify, …). It has to be served over HTTP, not opened as a file.

## Writing

The document is a list of blocks. Hover between blocks and click **＋** to insert one.

| Block | What it is |
| --- | --- |
| Text | Paragraphs: `$math$`, `$$display$$`, `**bold**`, `*italic*`, `- lists`, `[[references]]`, `{{snippets}}` |
| Heading | Numbered section heading |
| Grammar | BNF table: category, metavariable, alternatives |
| Rules | Inference rules (name, premises, conclusion, side condition) and an optional boxed judgment form |
| Proof tree | A derivation built by clicking |
| Lemma / Theorem | Kind, name, label, statement and a proof made of nested blocks |
| Case analysis | "By induction on…" with one case per rule, each with its own nested blocks |
| Raw code | Verbatim Typst and LaTeX for anything the editor doesn't cover |

All math is written in **LaTeX math syntax** (rendered live with KaTeX). It is
translated to Typst math for the preview and Typst export, and kept as-is in the
LaTeX export.

### Snippets

* **Math snippets** are macros: name `ty`, 3 arguments, body `#1 \vdash #2 : #3`,
  then write `\ty{\Gamma}{e}{\tau}` anywhere. Typing `\` in a math field
  autocompletes snippets and common symbols. In the LaTeX export they become
  `\newcommand`s; in Typst they are expanded.
* **Text snippets** expand `{{name}}` in prose, e.g. `{{ind}}` → "By induction on the derivation of".
* Clicking a snippet in the sidebar inserts it at the cursor.

### Proof trees

Click a judgment to select it, then use the toolbar or keys:

| Key | Action |
| --- | --- |
| Enter | edit the judgment |
| R | apply a rule: the picker lists rules whose conclusion matches first |
| P | add a premise |
| N | edit the rule label |
| B | insert a new conclusion below |
| ↑ ↓ ← → | move to premise / conclusion / siblings |
| Del | delete the subtree |

**Apply rule** matches the rule's conclusion against the judgment (single
letters and Greek letters in rules are metavariables, `\mathsf{…}` etc. are
literal, redundant parentheses are ignored) and fills in the premises.
Premise variables that the conclusion doesn't determine (like `\tau_1` in
T-App) become *unknowns*; applying rules further up the tree solves them and
substitutes the solution everywhere in the tree, or you can set them by hand.
Premises that no rule can derive (like `(x{:}\tau) \in \Gamma`) are treated as
side conditions. Open goals are underlined in orange and counted in the toolbar.

### References

`[[lem:canonical]]` references a lemma by its label ("Lemma 1"); `[[T-App]]`
typesets a rule name in small caps. Typing `[[` autocompletes.

## Exports

* **PDF**: compiled from the Typst export in the browser (⤓ PDF, or Open PDF).
* **Typst**: a self-contained `.typ` file (no packages needed); proof trees use a
  small `pw-rule` function defined at the top.
* **LaTeX**: an `article` using `amsthm`, `mathpartir` (rules and trees),
  `stmaryrd` and `cleveref`. Compiles with `pdflatex`.

## Development

```sh
npm test           # unit tests; also compiles the exports if `pdflatex` and the
                   # Python `typst` package are installed
npx tsc --noEmit   # type check
```

Source layout:

* `src/model` — document types, sample document, proof tree operations
* `src/latex` — LaTeX math tokenizer/parser, LaTeX→Typst converter, macro
  expansion, rule matching and unification
* `src/export` — prose format, Typst and LaTeX exporters
* `src/components` — the editor UI (React)
* `src/preview` — Typst compiler worker and SVG preview
* `public/fonts` — New Computer Modern (text and math) and DejaVu Sans Mono, from
  [typst-assets](https://github.com/typst/typst-assets)
