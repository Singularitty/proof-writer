# Proof Writer guide

How to use the editor. For an overview and install instructions, see the [README](../README.md).

## Writing

The document is a list of blocks. Click **＋** between blocks to insert one.
Drag a block by the **⠿** grip beside it, or by its type label, to move it. A
line shows where it will land. Blocks can be dragged into and out of proofs and
cases; headings stay at the top level.

**Sections.** Every top-level H1 heading starts a section. The tabs above the
editor show one section at a time (or **All** for the whole document), and
**＋ Section** adds a new one after the current section. Clicking an outline item
jumps to its section. The preview and exports always cover the whole document.

Clicking anywhere in the preview selects the block that produced that part of
the page and scrolls the editor to it, switching section if needed.
**↻ Recompile** above the preview compiles the whole document again and redraws
it from scratch, in case the preview ever looks wrong.

**Views.** The three buttons in the top bar collapse and reopen the sidebar,
the editor and the preview, so the others get the room. At least one stays
open, and the choice is remembered. Jumping to a block or to its place in the
preview opens that view again if it was collapsed.

The button at the right of the preview's toolbar moves the preview to a window
of its own, for a second screen. It keeps following the document there. The
same button, or closing that window, puts it back.

The **⇢** button beside a block goes the other way: it scrolls the preview to
that block's output and tints it for a moment.

| Block | What it is |
| --- | --- |
| Text | Paragraphs: `$math$`, `$$display$$`, `**bold**`, `*italic*`, `- lists`, `[[references]]`, `{{snippets}}` |
| Section, Subsection, Sub-subsection | Numbered heading at level 1, 2 or 3; a level-1 heading starts a new section |
| Grammar | BNF table: category, metavariable, alternatives |
| Rules | Inference rules (name, premises, conclusion, side condition) and an optional boxed judgment form |
| Proof tree | A derivation built by clicking |
| Definition | Name, label and statement, with no proof; rules, a grammar, a proof tree or more text can go inside it |
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
* A math snippet called with too few arguments is listed under the preview, and
  the missing argument shows as `?`. Deleting a snippet that is still used asks
  first and says how many places use it.

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

## Your documents

Documents are saved in the browser as you type (local storage, per browser and
site). The **Documents** tab lists them: click to open, double-click or ✎ to
rename, ⧉ to duplicate, × to delete. If the browser refuses to save (storage
full, private window), a red notice appears above the editor.

### Saving to a file

**Save to…** (Ctrl+S) asks where to put the document and writes it there as a
`.json` file. After that the button reads **Save** and writes to the same file,
and **Save as…** (Ctrl+Shift+S) picks a different one. A `.json` document opened
with **Open…** (Ctrl+O) is saved back to the file it came from.

This needs a browser that lets a page write to files, which today means Chrome,
Edge and other Chromium browsers. In Firefox and Safari the button is
**Save .json** and downloads a copy each time. The browser forgets which file a
document belongs to when the page is reloaded, so the first save after a reload
asks again.

### GitHub

**GitHub…** in the top bar opens documents from a repository and commits them back:

* **Open from GitHub**: enter `owner/repo` or paste a link to a repository,
  folder or file, then pick a `.json` document or a `.typ` file (imported).
* **Commit to GitHub**: commits the open document as a `.json` document, or as
  its Typst or LaTeX export. A document opened from GitHub defaults to the same
  file, and the commit is refused if the file changed on GitHub since.

Public repositories open without signing in. Private repositories and commits
need a fine-grained personal access token with *Contents: Read and write*; it
is stored only in this browser and sent only to `api.github.com`.

## Importing Typst

**Open…** also accepts a `.typ` file and imports it as a new document:

* `=` headings become headings, so each top-level `=` is a section;
* curryst `#prooftree(rule(...))` calls become rule blocks (nested rules become
  proof trees), and a `#box[$ … $]` right before them becomes the judgment form;
* `$ x ::= a | b $` displays become grammar rows, named by a bold label just above;
* prose keeps `*bold*`, `_emphasis_`, lists and `@refs`; all math is converted to
  LaTeX syntax;
* `// comments`, `#pagebreak()` and anything without an editor equivalent are
  kept as raw blocks, and listed in a note after the import.

## Exports

* **PDF**: compiled from the Typst export in the browser (⤓ PDF, or Open PDF).
* **Typst**: a self-contained `.typ` file (no packages needed); proof trees use a
  small `pw-rule` function defined at the top.
* **LaTeX**: an `article` using `amsthm`, `mathpartir` (rules and trees),
  `stmaryrd` and `cleveref`. Compiles with `pdflatex`.

## Checking a document

The **Tracker** tab in the sidebar checks the open document as you type. It
lists each statement with its problems and shows the number of errors and
warnings on the tab. Clicking a problem jumps to the block it is in.

`npm run check -- document.json` runs the same checks on a saved document and
prints the report as JSON.

| Check | Reported as |
| --- | --- |
| `[[reference]]` that names no statement or rule | `dangling-ref` |
| Label or rule name used twice | `duplicate-label`, `duplicate-rule` |
| Statements whose proofs depend on each other in a circle | `cycle` |
| Lemma nothing refers to | `unused` |
| Theorem, lemma, corollary or proposition with no proof | `no-proof` |
| Rule with no case in a case analysis, or with two | `missing-case`, `duplicate-case` |
| Case with nothing in it, or citing a rule of another judgment | `empty-case`, `foreign-case` |
| Proof tree with open leaves, elided derivations or unsolved unknowns | `open-leaf`, `elided`, `unknowns` |
| Proof tree step whose rule was deleted | `rule-missing` |
| Proof tree step whose judgment no longer matches its rule's conclusion, or with the wrong number of premises | `rule-drift` |

A case analysis is checked against one rules block. The checker finds it by
matching the math in the intro ("by induction on the derivation of
$\Gamma \vdash e : \tau$") against each block's judgment form, and failing that
by the rules the case titles cite. If neither identifies a block, coverage is
not checked. In the Tracker tab, the dropdown beside a case analysis shows the
block that was found and lets you choose another. Choosing one, or pressing
**confirm**, records it in the document, and a recorded block is used as it is. A case
covers a rule when its title names it, as `[[T-App]]` or as plain `T-App`.

The report also lists every statement with the labels its proof cites, and
every case analysis with its covered and missing rules.

### In Claude Code

`mod/proof-tracker` is a Claude Code plugin for working on a document with
Claude. `/proofs path/to/document.json` starts tracking a saved document:

* a pane lists the same statements and problems as the Tracker tab, and is
  refreshed when the file changes;
* Claude is given the current list of problems, and after each edit it makes to
  the document it is told what that edit fixed and what it broke;
* for a case analysis the checker could not place, Claude reads the statement
  and the intro and the pane offers its answer with **Accept** and **Dismiss**.
  Accept writes it into the document; nothing is written otherwise.

`/proofs` reopens the pane and `/proofs off` stops. The plugin runs the checker
from this repository, which it expects at `~/Projects/proof-writer`; set
`PROOF_WRITER_DIR` if it is elsewhere. Load it with
`claude --plugin-dir mod/proof-tracker`, and test it with
`claude plugin test mod/proof-tracker`.

### Limits

Not checked: induction on the structure of a term or type (cases drawn from a
grammar), whether the premises of a proof tree step fit together, and whether
the prose of a proof is correct.

## Files in the desktop app

The **Files** tab shows a folder. **Open folder…** chooses it, and the app
reopens it next time. Folders inside it can be entered; `‹ ..` goes back up.
Only documents (`.json`) and Typst files (`.typ`) are listed.

* Click a document to open it. Opening one that is already open switches to it
  rather than making a second copy.
* **＋ New** creates `Untitled.proof.json` in the folder and lets you name it.
* The buttons beside a file rename it, show it in the system's file manager, or
  move it to the trash. Nothing is ever deleted outright.
* A Typst file is imported as a new document, which is not in a file until you
  save it.

A document opened from a file, or saved to one, stays tied to it, also after
the app is restarted. The top bar shows the file's name, with a `●` while there
are edits not yet written to it. With **Save automatically** on in Settings,
which it is at first, the file is written a moment after each edit; Ctrl+S
writes it at once, and Ctrl+Shift+S saves to a different file.

If another program changes the file, the document is reloaded. If you have
edits that are not saved, the app asks whether to reload or keep yours. When a
document is opened, it is checked against its file in the same way.

Below the folder, **Open documents** lists everything the app has open, with
the file each is in. One marked *not in a file* exists only inside the app
until you save it. Closing a document that is in a file leaves the file alone.

