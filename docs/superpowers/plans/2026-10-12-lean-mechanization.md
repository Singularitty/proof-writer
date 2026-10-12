# Lean Mechanization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **Lean** tab in the desktop app that has Claude Code translate a document's definitions and statements into a Lean 4 project beside the document, prove statements on request, and report failures, deviations and proposed document edits against the blocks they concern.

**Architecture:** Pure TypeScript in `src/lean/` decides everything that can be decided without a process: what is out of date, what the prompts say, how a build's output and the Lean files' contents become statuses, and whether a proposal still applies. `electron/lean.cjs` does the rest: finds `claude` and `lake`, keeps the Lake project's fixed files, spawns the headless CLI and `lake build`, and reads and writes the status file. The renderer orchestrates a job through the `window.desktop.lean` bridge; nothing Claude reports sets a status.

**Tech Stack:** TypeScript, React 18, zustand, vitest, Electron 33 (CommonJS main process), the `claude` CLI (2.1.x) run headless, Lean 4 with Lake.

**Spec:** `docs/superpowers/specs/2026-10-12-lean-mechanization-design.md`

## Global Constraints

* Desktop app only. Every new UI element is absent when `desktop` (from `src/util/desktop.ts`) is undefined.
* No new npm dependencies.
* Claude writes Lean files only. The document is changed only by the user accepting a proposal, as one undo step.
* The Lean folder for `<name>.proof.json` or `<name>.json` is `<name>-lean/` beside it. Library name `PW`. Files: `lakefile.toml`, `lean-toolchain`, `PW.lean`, `PW/Defs.lean`, `PW/<Module>.lean`, `CLAUDE.md`, `CONVENTIONS.md`, `document.json`, `document.md`, `mechanization.json`, `.gitignore`.
* Marker comment before every declaration that comes from a block: `-- pw: <block id>`; on a rule's constructor `-- pw: <block id> <rule id>`.
* Plain Lean 4, no dependencies in `lakefile.toml`.
* Model choices: `fable`, `opus`, `sonnet`, `haiku`. Effort choices: `low`, `medium`, `high`, `xhigh`, `max`. An empty string means Default and passes no flag.
* A job is stopped after 30 minutes. One job at a time per window.
* `mechanization.json` is written only by the app, atomically.
* Code style: match the surrounding file. Comments are full sentences saying why, as in `src/check/` and `electron/`. Tests live in `tests/*.test.ts` and use vitest.

### Where the plan departs from the spec

These were settled while confirming the spec's open points against the installed CLI (2.1.296) and the code:

* **CLI flags.** `--restricted --strict-mcp-config --permission-prompts none --tools "Bash,Read,Edit,Write,Glob,Grep" --allowedTools "Bash(lake build)" "Bash(lake build *)" "Bash(lake env lean *)" Read Edit Write Glob Grep` gives the tool limits, the folder confinement and the isolation from user plugins. Verified: `lake build` runs, `ls ..` is refused, reads and writes outside the folder are refused, no user plugin loads. `--verbose` is required with `--output-format stream-json`. The report arrives as `structured_output` on the final `{"type":"result"}` event.
* **`CLAUDE.md` is not loaded in restricted mode**, so the app passes its text, followed by the text of `CONVENTIONS.md`, with `--append-system-prompt`. The file is still written to the folder for sessions the user opens by hand.
* **The `sorry`/`axiom` scan and the build-output parser are in `src/lean/build.ts`**, not the main process: main returns the raw build output and the text of the Lean files. This keeps them testable with the other pure code.
* **Lean state is in its own zustand store, `src/lean/store.ts`**, not `src/store.ts`. Accepting a proposal still goes through `useStore.getState().update`.
* **Each stored block also records its `kind`**, so a deleted definition can be told from a deleted statement.
* **`PW.lean` is rewritten by the app before every build** from the files present in `PW/`; Claude is told not to edit it.
* **npm's global bin directory is approximated** by `/usr/local/bin`, `/opt/homebrew/bin`, `~/.npm-global/bin` and `%APPDATA%\npm`, since finding it exactly needs `npm` on the PATH.
* **Windows is not verified.** The code handles `.cmd`/`.exe` lookup and spawns through a shell there, but nothing in this plan runs on Windows.

## Review Focus

1. **A stream that is not clean JSON lines.** The CLI's stdout may split a line across chunks or print a non-JSON line. Expected: the run still ends with its report. Pinned in Task 7 ("survives split and non-JSON lines").
2. **Labels that make bad or equal module names.** `2nd`, `lem:a-b` and `lem:a_b`, an empty label, the label `defs`. Expected: every statement gets a distinct valid Lean module name. Pinned in Task 1 ("module names").
3. **A proposal whose target has moved on.** The "before" text was edited, the rule was deleted, the premise index is out of range. Expected: shown as no longer applicable; accepting does nothing and does not throw. Pinned in Task 5.
4. **A status file that is not what the app wrote.** Truncated JSON, a hand edit, `version: 2`, blocks the document no longer has. Expected: treated as empty or the bad parts dropped; the tab still opens. Pinned in Task 2 and Task 7.
5. **A build that fails without a Lean error.** A broken `lakefile.toml`, a missing toolchain or a build cut short leaves the Lean files unchecked. Expected: an error in the tab and the Recreate action, and no status written; never Proved from a file that was not compiled. Pinned in Task 9 ("writes nothing when Lake fails without a Lean error").
6. **A proof that looks finished only because something it imports is broken.** Lake does not build a file whose import failed, so the file has no errors of its own and no `sorry`. Expected: Failed with "not checked", never Proved. Pinned in Task 4 ("a statement citing a failed one").

---

### Task 1: Items, hashes, module names and staleness

**Files:**
- Create: `src/lean/items.ts`
- Test: `tests/lean-items.test.ts`

**Interfaces:**
- Consumes: `Doc`, `Block`, `Id`, `TheoremKind` from `src/model/types.ts`; `walkBlocks`, `sanitizeLabel` from `src/export/context.ts`; `hasContent` from `src/check/coverage.ts`.
- Produces:
  - `type ItemKind = 'grammar' | 'rules' | 'definition' | 'statement'`
  - `interface Item { id: Id; kind: ItemKind; hash: string; proofHash?: string; hasProof: boolean; label: string; title: string; theoremKind?: TheoremKind; module?: string }`
  - `docItems(doc: Doc): Item[]` in document order; `module` is set on statements only.
  - `interface Staleness { stale: Set<Id>; fresh: Set<Id>; deleted: Id[]; defsStale: boolean; proofChanged: Set<Id> }`
  - `staleness(items: Item[], recorded: Record<Id, { hash: string; proofHash?: string; kind: ItemKind }>): Staleness`

- [ ] **Step 1: Write the failing test**

`tests/lean-items.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { docItems, staleness } from '../src/lean/items';
import type { Block, Doc, Rule } from '../src/model/types';

let n = 0;
const id = () => `t${++n}`;
function doc(blocks: Block[], snippets: Doc['snippets'] = []): Doc {
  return { version: 1, title: 't', author: '', snippets, blocks, settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' } };
}
const rule = (name: string, conclusion: string, premises: string[] = []): Rule => ({ id: id(), name, premises, conclusion });
const rules = (rs: Rule[], title = 'Typing'): Block & { type: 'rules' } => ({ id: id(), type: 'rules', title, judgment: '\\ty{\\Gamma}{e}{\\tau}', rules: rs });
const grammar = (): Block & { type: 'grammar' } => ({ id: id(), type: 'grammar', title: 'Syntax', rows: [{ id: id(), category: 'Types', metavar: '\\tau', alternatives: ['\\mathsf{Bool}'] }] });
const stmt = (label: string, kind: 'lemma' | 'theorem' | 'definition' | 'conjecture' = 'lemma', proof?: Block[]): Block & { type: 'theorem' } =>
  ({ id: id(), type: 'theorem', kind, title: '', label, statement: 'If $\\ty{\\Gamma}{e}{\\tau}$ then fine.', proof });
const text = (t: string): Block => ({ id: id(), type: 'text', text: t });
const ty = { id: 's1', kind: 'math' as const, name: 'ty', arity: 3, body: '#1 \\vdash #2 : #3' };

const record = (d: Doc) => Object.fromEntries(docItems(d).map((i) => [i.id, { hash: i.hash, proofHash: i.proofHash, kind: i.kind }]));

describe('the items of a document', () => {
  it('lists grammars, rules, definitions and statements in order', () => {
    const d = doc([grammar(), rules([rule('T-True', 'x')]), stmt('def:val', 'definition'), stmt('lem:a', 'lemma', [text('By induction.')]), stmt('conj:b', 'conjecture')]);
    expect(docItems(d).map((i) => i.kind)).toEqual(['grammar', 'rules', 'definition', 'statement', 'statement']);
    expect(docItems(d).map((i) => i.hasProof)).toEqual([false, false, false, true, false]);
  });
  it('finds rules inside a definition', () => {
    const inner = rules([rule('V-True', 'v')]);
    const d = doc([{ ...stmt('def:val', 'definition'), proof: [inner] }]);
    expect(docItems(d).map((i) => i.id)).toContain(inner.id);
  });
});

describe('hashes', () => {
  it('change with the content that carries meaning and not with titles', () => {
    const r = rules([rule('T-True', 'x')]);
    const before = docItems(doc([r]))[0].hash;
    expect(docItems(doc([{ ...r, title: 'Other title' }]))[0].hash).toBe(before);
    expect(docItems(doc([{ ...r, rules: [{ ...r.rules[0], premises: ['p'] }] }]))[0].hash).not.toBe(before);
    expect(docItems(doc([{ ...r, rules: [{ ...r.rules[0], side: 'x \\notin \\Gamma' }] }]))[0].hash).not.toBe(before);
  });
  it('change when a snippet the block uses changes, directly or through another snippet', () => {
    const r = rules([rule('T-True', '\\ty{\\Gamma}{e}{\\tau}')]);
    const before = docItems(doc([r], [ty]))[0].hash;
    expect(docItems(doc([r], [{ ...ty, body: '#1 \\Vdash #2 : #3' }]))[0].hash).not.toBe(before);
    const unused = { id: 's2', kind: 'math' as const, name: 'step', arity: 2, body: '#1 \\to #2' };
    expect(docItems(doc([r], [ty, unused]))[0].hash).toBe(before);
    const outer = { id: 's3', kind: 'math' as const, name: 'ty', arity: 3, body: '\\turn{#1} #2 : #3' };
    const turn = { id: 's4', kind: 'math' as const, name: 'turn', arity: 1, body: '#1 \\vdash' };
    const viaBefore = docItems(doc([r], [outer, turn]))[0].hash;
    expect(docItems(doc([r], [outer, { ...turn, body: '#1 \\Vdash' }]))[0].hash).not.toBe(viaBefore);
  });
  it('keep a statement and its proof apart', () => {
    const s = stmt('lem:a', 'lemma', [text('By induction.')]);
    const a = docItems(doc([s]))[0];
    const b = docItems(doc([{ ...s, proof: [{ ...s.proof![0], text: 'By cases.' } as Block] }]))[0];
    expect(b.hash).toBe(a.hash);
    expect(b.proofHash).not.toBe(a.proofHash);
  });
});

describe('module names', () => {
  const names = (labels: string[]) => docItems(doc(labels.map((l) => stmt(l)))).map((i) => i.module!);
  it('are made from labels', () => {
    expect(names(['lem:canonical', 'thm:type-soundness'])).toEqual(['LemCanonical', 'ThmTypeSoundness']);
  });
  it('are valid and distinct whatever the labels', () => {
    const ms = names(['2nd', 'lem:a-b', 'lem:a_b', '', '', 'defs', 'λ→']);
    for (const m of ms) expect(m).toMatch(/^[A-Z][A-Za-z0-9_]*$/);
    expect(new Set(ms).size).toBe(ms.length);
    expect(ms).not.toContain('Defs');
  });
});

describe('staleness', () => {
  it('is empty right after recording', () => {
    const d = doc([rules([rule('T-True', 'x')]), stmt('lem:a')]);
    const s = staleness(docItems(d), record(d));
    expect([...s.stale]).toEqual([]);
    expect(s.defsStale).toBe(false);
  });
  it('marks a changed statement alone', () => {
    const r = rules([rule('T-True', 'x')]);
    const a = stmt('lem:a');
    const rec = record(doc([r, a]));
    const s = staleness(docItems(doc([r, { ...a, statement: 'Changed.' }])), rec);
    expect([...s.stale]).toEqual([a.id]);
    expect(s.defsStale).toBe(false);
  });
  it('reports a changed, new or deleted definition as stale definitions', () => {
    const r = rules([rule('T-True', 'x')]);
    const g = grammar();
    const a = stmt('lem:a');
    const rec = record(doc([r, a]));
    expect(staleness(docItems(doc([{ ...r, judgment: 'other' }, a])), rec).defsStale).toBe(true);
    const added = staleness(docItems(doc([r, g, a])), rec);
    expect(added.defsStale).toBe(true);
    expect([...added.fresh]).toEqual([g.id]);
    const gone = staleness(docItems(doc([a])), rec);
    expect(gone.defsStale).toBe(true);
    expect(gone.deleted).toEqual([r.id]);
  });
  it('does not call a deleted statement a stale definition', () => {
    const a = stmt('lem:a');
    const b = stmt('lem:b');
    const s = staleness(docItems(doc([a])), record(doc([a, b])));
    expect(s.deleted).toEqual([b.id]);
    expect(s.defsStale).toBe(false);
  });
  it('notes a proof edited since it was proved', () => {
    const a = stmt('lem:a', 'lemma', [text('By induction.')]);
    const rec = record(doc([a]));
    const s = staleness(docItems(doc([{ ...a, proof: [text('By cases.')] }])), rec);
    expect([...s.proofChanged]).toEqual([a.id]);
    expect([...s.stale]).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lean-items.test.ts`
Expected: FAIL, cannot resolve `../src/lean/items`.

- [ ] **Step 3: Write the implementation**

`src/lean/items.ts`:

```ts
// What a document offers for mechanization: its definitions (grammars, rules
// blocks, definition statements) and its statements, each with a hash of the
// content that carries meaning. Comparing hashes with those recorded at the
// last translation says what is out of date.

import type { Block, Doc, Id, Snippet, TheoremKind } from '../model/types';
import { sanitizeLabel, walkBlocks } from '../export/context';
import { hasContent } from '../check/coverage';

export type ItemKind = 'grammar' | 'rules' | 'definition' | 'statement';

export interface Item {
  id: Id;
  kind: ItemKind;
  hash: string;
  /** Statements only: the hash of the written proof. */
  proofHash?: string;
  hasProof: boolean;
  label: string;
  title: string;
  theoremKind?: TheoremKind;
  /** Statements only: the Lean module holding it, without the `PW.` prefix. */
  module?: string;
}

/** A 53-bit string hash (cyrb53), as hex. Collisions only cost a missed "out of date". */
function hashText(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The snippets `text` calls, and those they call, as one string in name order. */
function snippetsUsed(text: string, snippets: Snippet[]): string {
  const used = new Map<string, Snippet>();
  const visit = (t: string) => {
    for (const s of snippets) {
      if (!s.name || used.has(s.kind + s.name)) continue;
      const call = s.kind === 'math' ? new RegExp(`\\\\${escape(s.name)}(?![A-Za-z])`) : new RegExp(`\\{\\{\\s*${escape(s.name)}\\s*\\}\\}`);
      if (!call.test(t)) continue;
      used.set(s.kind + s.name, s);
      visit(s.body);
    }
  };
  visit(text);
  return [...used.keys()].sort().map((k) => { const s = used.get(k)!; return `${k}/${s.arity}=${s.body}`; }).join('\n');
}

function hashOf(content: unknown, snippets: Snippet[]): string {
  const text = JSON.stringify(content);
  return hashText(text + '\n' + snippetsUsed(text, snippets));
}

/** The prose a definition holds besides its statement: the text blocks inside it. */
function proseInside(blocks: Block[] | undefined): string[] {
  const out: string[] = [];
  if (blocks) walkBlocks(blocks, (b) => { if (b.type === 'text') out.push(b.text); });
  return out;
}

const camel = (s: string) => s.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1)).join('');

/** A Lean module name for each statement: valid, not `Defs`, and no two the same. */
function moduleNames(statements: { id: Id; label: string }[]): Map<Id, string> {
  const out = new Map<Id, string>();
  const taken = new Set<string>(['Defs']);
  for (const s of statements) {
    let name = camel(s.label);
    if (!name) name = 'S' + camel(s.id);
    if (!/^[A-Z]/.test(name)) name = 'S' + name;
    if (taken.has(name)) name = `${name}_${camel(s.id) || out.size}`;
    while (taken.has(name)) name += '_';
    taken.add(name);
    out.set(s.id, name);
  }
  return out;
}

export function docItems(doc: Doc): Item[] {
  const items: Item[] = [];
  walkBlocks(doc.blocks, (b) => {
    if (b.type === 'grammar') {
      const content = b.rows.map((r) => [r.category, r.metavar, r.alternatives]);
      items.push({ id: b.id, kind: 'grammar', hash: hashOf(content, doc.snippets), hasProof: false, label: '', title: b.title });
    } else if (b.type === 'rules') {
      const content = [b.judgment ?? '', b.rules.map((r) => [r.name, r.premises, r.conclusion, r.side ?? ''])];
      items.push({ id: b.id, kind: 'rules', hash: hashOf(content, doc.snippets), hasProof: false, label: '', title: b.title });
    } else if (b.type === 'theorem' && b.kind === 'definition') {
      const content = [sanitizeLabel(b.label), b.statement, proseInside(b.proof)];
      items.push({ id: b.id, kind: 'definition', hash: hashOf(content, doc.snippets), hasProof: false, label: sanitizeLabel(b.label), title: b.title, theoremKind: b.kind });
    } else if (b.type === 'theorem') {
      items.push({
        id: b.id, kind: 'statement',
        hash: hashOf([b.kind, sanitizeLabel(b.label), b.statement], doc.snippets),
        proofHash: hashOf(b.proof ?? [], doc.snippets),
        hasProof: hasContent(b.proof), label: sanitizeLabel(b.label), title: b.title, theoremKind: b.kind,
      });
    }
  });
  const modules = moduleNames(items.filter((i) => i.kind === 'statement'));
  for (const i of items) if (i.kind === 'statement') i.module = modules.get(i.id);
  return items;
}

export interface Staleness {
  /** Items whose content changed since they were translated. */
  stale: Set<Id>;
  /** Items never translated. */
  fresh: Set<Id>;
  /** Translated blocks the document no longer has. */
  deleted: Id[];
  /** A definition changed, appeared or went away, so every statement needs checking again. */
  defsStale: boolean;
  /** Statements whose written proof changed since it was mechanized. */
  proofChanged: Set<Id>;
}

export function staleness(items: Item[], recorded: Record<Id, { hash: string; proofHash?: string; kind: ItemKind }>): Staleness {
  const out: Staleness = { stale: new Set(), fresh: new Set(), deleted: [], defsStale: false, proofChanged: new Set() };
  const anyRecorded = Object.keys(recorded).length > 0;
  const seen = new Set<Id>();
  for (const i of items) {
    seen.add(i.id);
    const r = recorded[i.id];
    if (!r) {
      out.fresh.add(i.id);
      if (i.kind !== 'statement' && anyRecorded) out.defsStale = true;
      continue;
    }
    if (r.hash !== i.hash) {
      out.stale.add(i.id);
      if (i.kind !== 'statement') out.defsStale = true;
    }
    if (r.proofHash !== undefined && i.proofHash !== undefined && r.proofHash !== i.proofHash) out.proofChanged.add(i.id);
  }
  for (const [id, r] of Object.entries(recorded)) {
    if (seen.has(id)) continue;
    out.deleted.push(id);
    if (r.kind !== 'statement') out.defsStale = true;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lean-items.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lean/items.ts tests/lean-items.test.ts
git commit -m "Hash a document's definitions and statements for mechanization"
```

---

### Task 2: The status file and the job report

**Files:**
- Create: `src/lean/status.ts`
- Test: `tests/lean-status.test.ts`

**Interfaces:**
- Consumes: `Id` from `src/model/types.ts`; `ItemKind` from `src/lean/items.ts`.
- Produces:
  - `type FindingKind = 'deviation' | 'inconsistency' | 'stuck'`
  - `interface Finding { kind: FindingKind; block: Id; at?: Id; related?: Id[]; message: string; lean?: { file: string; line: number } }`
  - `type ProposalField = 'statement' | 'text' | 'premise' | 'conclusion' | 'side' | 'alternative'`
  - `interface ProposalTarget { field: ProposalField; rule?: Id; row?: Id; index?: number }`
  - `interface Proposal { block: Id; target: ProposalTarget; before: string; after: string; why: string }`
  - `interface StoredProposal extends Proposal { id: string; state: 'open' | 'dismissed' | 'accepted' }`
  - `type Outcome = 'done' | 'partial' | 'failed'`
  - `interface JobReport { outcome: Outcome; summary: string; blocks: { block: Id; file: string; names: string[] }[]; findings: Finding[]; proposals: Proposal[]; changes: Change[] }`
  - `interface Change { file: string; name: string; change: 'added' | 'changed' | 'removed' }`
  - `type BlockStatus = 'translated' | 'stated' | 'proved' | 'failed'`
  - `interface MechBlock { kind: ItemKind; hash: string; proofHash?: string; file: string; names: string[]; status: BlockStatus; assumes?: Id[]; findings: Finding[] }`
  - `interface LastJob { kind: 'sync' | 'prove'; target?: Id; endedAt: string; model?: string; effort?: string; outcome: Outcome | 'cancelled'; summary: string; changes: Change[] }`
  - `interface Mechanization { version: 1; blocks: Record<Id, MechBlock>; proposals: StoredProposal[]; lastJob?: LastJob }`
  - `emptyMechanization(): Mechanization`
  - `readMechanization(v: unknown): Mechanization` (never throws)
  - `readReport(v: unknown, known: ReadonlySet<Id>): JobReport | null`
  - `FINDING_KINDS`, `PROPOSAL_FIELDS`, `OUTCOMES` as readonly arrays.

- [ ] **Step 1: Write the failing test**

`tests/lean-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { emptyMechanization, readMechanization, readReport } from '../src/lean/status';

const known = new Set(['b1', 'b2']);
const report = {
  outcome: 'partial', summary: 'One lemma stuck.',
  blocks: [{ block: 'b1', file: 'PW/Defs.lean', names: ['Ty', 'HasType'] }, { block: 'nope', file: 'x', names: [] }],
  findings: [
    { kind: 'deviation', block: 'b2', message: 'Added a hypothesis.', lean: { file: 'PW/LemA.lean', line: 4 } },
    { kind: 'inconsistency', block: 'b2', related: ['b1', 'gone'], message: 'Rule and lemma disagree.' },
    { kind: 'stuck', block: 'gone', message: 'x' },
    { kind: 'opinion', block: 'b1', message: 'x' },
  ],
  proposals: [
    { block: 'b2', target: { field: 'statement' }, before: 'a', after: 'b', why: 'w' },
    { block: 'b1', target: { field: 'premise', rule: 'r1', index: 0 }, before: 'a', after: 'b', why: 'w' },
    { block: 'b1', target: { field: 'premise' }, before: 'a', after: 'b', why: 'no rule' },
    { block: 'b1', target: { field: 'title' }, before: 'a', after: 'b', why: 'w' },
  ],
  changes: [{ file: 'PW/Defs.lean', name: 'Ty', change: 'added' }, { file: 'x', name: 'y', change: 'renamed' }],
};

describe('reading a job report', () => {
  it('keeps what is well formed and names blocks the document has', () => {
    const r = readReport(report, known)!;
    expect(r.outcome).toBe('partial');
    expect(r.blocks.map((b) => b.block)).toEqual(['b1']);
    expect(r.findings.map((f) => f.kind)).toEqual(['deviation', 'inconsistency']);
    expect(r.findings[1].related).toEqual(['b1']);
    expect(r.proposals.map((p) => p.target.field)).toEqual(['statement', 'premise']);
    expect(r.changes).toEqual([{ file: 'PW/Defs.lean', name: 'Ty', change: 'added' }]);
  });
  it('is null for anything that is not a report', () => {
    for (const v of [null, 'text', 42, [], {}, { outcome: 'great' }]) expect(readReport(v, known)).toBe(null);
  });
  it('fills in missing lists', () => {
    expect(readReport({ outcome: 'done' }, known)).toEqual({ outcome: 'done', summary: '', blocks: [], findings: [], proposals: [], changes: [] });
  });
});

describe('reading the status file', () => {
  const good = {
    version: 1,
    blocks: {
      b1: { kind: 'rules', hash: 'h', file: 'PW/Defs.lean', names: ['HasType'], status: 'translated', findings: [] },
      b2: { kind: 'statement', hash: 'h', proofHash: 'p', file: 'PW/LemA.lean', names: ['lemA'], status: 'proved', assumes: ['b3'], findings: [{ kind: 'deviation', block: 'b2', message: 'm' }] },
      bad: { kind: 'statement', hash: 3, status: 'proved' },
    },
    proposals: [{ id: 'p1', state: 'dismissed', block: 'b2', target: { field: 'statement' }, before: 'a', after: 'b', why: 'w' }, { id: 'p2', state: 'maybe' }],
    lastJob: { kind: 'prove', target: 'b2', endedAt: '2026-10-12T10:00:00.000Z', model: 'opus', effort: 'high', outcome: 'done', summary: 's', changes: [] },
  };
  it('reads a file the app wrote', () => {
    const m = readMechanization(good);
    expect(Object.keys(m.blocks)).toEqual(['b1', 'b2']);
    expect(m.blocks.b2.assumes).toEqual(['b3']);
    expect(m.blocks.b2.findings).toHaveLength(1);
    expect(m.proposals.map((p) => p.id)).toEqual(['p1']);
    expect(m.lastJob?.model).toBe('opus');
  });
  it('is empty for anything else, and never throws', () => {
    for (const v of [null, undefined, 'x', [], {}, { version: 2, blocks: good.blocks }, { version: 1, blocks: 'no' }]) {
      expect(readMechanization(v)).toEqual(emptyMechanization());
    }
  });
  it('drops a last job it cannot read', () => {
    expect(readMechanization({ ...good, lastJob: { kind: 'dance' } }).lastJob).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lean-status.test.ts`
Expected: FAIL, cannot resolve `../src/lean/status`.

- [ ] **Step 3: Write the implementation**

`src/lean/status.ts`:

```ts
// The two records of a mechanization: what a job reports when it ends, and
// what the app keeps in mechanization.json. Both are read defensively: the
// report is written by a model and the file can be edited by hand, so
// anything malformed is dropped rather than trusted.

import type { Id } from '../model/types';
import type { ItemKind } from './items';

export const FINDING_KINDS = ['deviation', 'inconsistency', 'stuck'] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  kind: FindingKind;
  block: Id;
  /** A case of a case analysis, when the finding is about one. */
  at?: Id;
  /** Other blocks an inconsistency involves. */
  related?: Id[];
  message: string;
  lean?: { file: string; line: number };
}

export const PROPOSAL_FIELDS = ['statement', 'text', 'premise', 'conclusion', 'side', 'alternative'] as const;
export type ProposalField = (typeof PROPOSAL_FIELDS)[number];

export interface ProposalTarget {
  field: ProposalField;
  /** For premise, conclusion and side: the rule. */
  rule?: Id;
  /** For alternative: the grammar production. */
  row?: Id;
  /** For premise and alternative: which one. A premise index one past the end adds a premise. */
  index?: number;
}

export interface Proposal { block: Id; target: ProposalTarget; before: string; after: string; why: string }
export interface StoredProposal extends Proposal { id: string; state: 'open' | 'dismissed' | 'accepted' }

export const OUTCOMES = ['done', 'partial', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface Change { file: string; name: string; change: 'added' | 'changed' | 'removed' }

export interface JobReport {
  outcome: Outcome;
  summary: string;
  /** Lean declarations that came from each block. */
  blocks: { block: Id; file: string; names: string[] }[];
  findings: Finding[];
  proposals: Proposal[];
  changes: Change[];
}

export type BlockStatus = 'translated' | 'stated' | 'proved' | 'failed';

export interface MechBlock {
  kind: ItemKind;
  hash: string;
  proofHash?: string;
  file: string;
  names: string[];
  status: BlockStatus;
  /** Cited statements still unproved. */
  assumes?: Id[];
  findings: Finding[];
}

export interface LastJob {
  kind: 'sync' | 'prove';
  target?: Id;
  endedAt: string;
  model?: string;
  effort?: string;
  outcome: Outcome | 'cancelled';
  summary: string;
  changes: Change[];
}

export interface Mechanization {
  version: 1;
  blocks: Record<Id, MechBlock>;
  proposals: StoredProposal[];
  lastJob?: LastJob;
}

export const emptyMechanization = (): Mechanization => ({ version: 1, blocks: {}, proposals: [] });

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => isStr(v) && (all as readonly string[]).includes(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
const list = <T>(v: unknown, read: (x: unknown) => T | null): T[] => (Array.isArray(v) ? v.map(read).filter((x): x is T => x !== null) : []);

function readFinding(v: unknown, known: ReadonlySet<Id> | null): Finding | null {
  if (!isObj(v) || !oneOf(v.kind, FINDING_KINDS) || !isStr(v.block) || !isStr(v.message)) return null;
  if (known && !known.has(v.block)) return null;
  const f: Finding = { kind: v.kind, block: v.block, message: v.message };
  if (isStr(v.at)) f.at = v.at;
  const related = strings(v.related).filter((id) => !known || known.has(id));
  if (related.length) f.related = related;
  if (isObj(v.lean) && isStr(v.lean.file) && typeof v.lean.line === 'number') f.lean = { file: v.lean.file, line: v.lean.line };
  return f;
}

function readTarget(v: unknown): ProposalTarget | null {
  if (!isObj(v) || !oneOf(v.field, PROPOSAL_FIELDS)) return null;
  const index = typeof v.index === 'number' && Number.isInteger(v.index) && v.index >= 0 ? v.index : undefined;
  switch (v.field) {
    case 'statement': case 'text': return { field: v.field };
    case 'conclusion': case 'side': return isStr(v.rule) ? { field: v.field, rule: v.rule } : null;
    case 'premise': return isStr(v.rule) && index !== undefined ? { field: 'premise', rule: v.rule, index } : null;
    case 'alternative': return isStr(v.row) && index !== undefined ? { field: 'alternative', row: v.row, index } : null;
  }
}

function readProposal(v: unknown, known: ReadonlySet<Id> | null): Proposal | null {
  if (!isObj(v) || !isStr(v.block) || !isStr(v.before) || !isStr(v.after)) return null;
  if (known && !known.has(v.block)) return null;
  const target = readTarget(v.target);
  return target ? { block: v.block, target, before: v.before, after: v.after, why: isStr(v.why) ? v.why : '' } : null;
}

function readChange(v: unknown): Change | null {
  if (!isObj(v) || !isStr(v.file) || !isStr(v.name) || !oneOf(v.change, ['added', 'changed', 'removed'] as const)) return null;
  return { file: v.file, name: v.name, change: v.change };
}

/** A job's report with everything malformed, or about a block the document does not have, left out. Null if it is not a report at all. */
export function readReport(v: unknown, known: ReadonlySet<Id>): JobReport | null {
  if (!isObj(v) || !oneOf(v.outcome, OUTCOMES)) return null;
  return {
    outcome: v.outcome,
    summary: isStr(v.summary) ? v.summary : '',
    blocks: list(v.blocks, (b) => (isObj(b) && isStr(b.block) && known.has(b.block) && isStr(b.file) ? { block: b.block, file: b.file, names: strings(b.names) } : null)),
    findings: list(v.findings, (f) => readFinding(f, known)),
    proposals: list(v.proposals, (p) => readProposal(p, known)),
    changes: list(v.changes, readChange),
  };
}

function readBlock(v: unknown): MechBlock | null {
  if (!isObj(v) || !isStr(v.hash) || !isStr(v.file)) return null;
  if (!oneOf(v.kind, ['grammar', 'rules', 'definition', 'statement'] as const)) return null;
  if (!oneOf(v.status, ['translated', 'stated', 'proved', 'failed'] as const)) return null;
  const b: MechBlock = { kind: v.kind, hash: v.hash, file: v.file, names: strings(v.names), status: v.status, findings: list(v.findings, (f) => readFinding(f, null)) };
  if (isStr(v.proofHash)) b.proofHash = v.proofHash;
  const assumes = strings(v.assumes);
  if (assumes.length) b.assumes = assumes;
  return b;
}

function readLastJob(v: unknown): LastJob | undefined {
  if (!isObj(v) || !oneOf(v.kind, ['sync', 'prove'] as const) || !isStr(v.endedAt)) return undefined;
  if (!oneOf(v.outcome, [...OUTCOMES, 'cancelled'] as const)) return undefined;
  const j: LastJob = { kind: v.kind, endedAt: v.endedAt, outcome: v.outcome, summary: isStr(v.summary) ? v.summary : '', changes: list(v.changes, readChange) };
  if (isStr(v.target)) j.target = v.target;
  if (isStr(v.model)) j.model = v.model;
  if (isStr(v.effort)) j.effort = v.effort;
  return j;
}

/** What mechanization.json holds. A missing, unreadable or foreign file reads as an empty one. */
export function readMechanization(v: unknown): Mechanization {
  if (!isObj(v) || v.version !== 1 || !isObj(v.blocks)) return emptyMechanization();
  const blocks: Record<Id, MechBlock> = {};
  for (const [id, raw] of Object.entries(v.blocks)) {
    const b = readBlock(raw);
    if (b) blocks[id] = b;
  }
  const proposals = list(v.proposals, (p): StoredProposal | null => {
    const read = readProposal(p, null);
    if (!read || !isObj(p) || !isStr(p.id) || !oneOf(p.state, ['open', 'dismissed', 'accepted'] as const)) return null;
    return { ...read, id: p.id, state: p.state };
  });
  const out: Mechanization = { version: 1, blocks, proposals };
  const lastJob = readLastJob(v.lastJob);
  if (lastJob) out.lastJob = lastJob;
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lean-status.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lean/status.ts tests/lean-status.test.ts
git commit -m "Read the mechanization status file and job reports defensively"
```

---

### Task 3: Build output, markers and the sorry/axiom scan

**Files:**
- Create: `src/lean/build.ts`
- Test: `tests/lean-build.test.ts`

**Interfaces:**
- Consumes: `Id` from `src/model/types.ts`.
- Produces:
  - `interface Diagnostic { file: string; line: number; column: number; severity: 'error' | 'warning' | 'info'; message: string }` where `file` is relative to the Lean folder with forward slashes (`PW/Defs.lean`).
  - `parseBuild(output: string): Diagnostic[]`
  - `interface Marker { line: number; block: Id; rule?: Id }` (lines are 1-based)
  - `markers(text: string): Marker[]`
  - `interface Scan { sorries: number[]; axioms: { line: number; name: string }[] }`
  - `scan(text: string): Scan`

- [ ] **Step 1: Write the failing test**

`tests/lean-build.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { markers, parseBuild, scan } from '../src/lean/build';

describe('reading lake build output', () => {
  it('reads diagnostics in the current format, with messages that run over lines', () => {
    const out = [
      '✖ [2/4] Building PW.Defs',
      'trace: .> LEAN_PATH=... lean ././././PW/Defs.lean',
      "error: ././././PW/Defs.lean:12:4: unknown identifier 'Ctx'",
      'error: ././././PW/Defs.lean:20:2: type mismatch',
      '  h',
      'has type',
      '  Nat',
      "warning: ././././PW/LemA.lean:7:8: declaration uses 'sorry'",
      'error: Lean exited with code 1',
      'Some required builds logged failures:',
      '- PW.Defs',
      'error: build failed',
    ].join('\n');
    expect(parseBuild(out)).toEqual([
      { file: 'PW/Defs.lean', line: 12, column: 4, severity: 'error', message: "unknown identifier 'Ctx'" },
      { file: 'PW/Defs.lean', line: 20, column: 2, severity: 'error', message: 'type mismatch\n  h\nhas type\n  Nat' },
      { file: 'PW/LemA.lean', line: 7, column: 8, severity: 'warning', message: "declaration uses 'sorry'" },
    ]);
  });
  it('reads the older format and absolute or Windows paths', () => {
    const out = [
      './././PW/Defs.lean:3:2: error: unexpected token',
      '/home/u/stlc-lean/PW/LemA.lean:5:0: warning: unused variable',
      'error: C:\\docs\\stlc-lean\\PW\\LemB.lean:9:1: oops',
    ].join('\n');
    expect(parseBuild(out).map((d) => `${d.file}:${d.line}:${d.severity}`)).toEqual(['PW/Defs.lean:3:error', 'PW/LemA.lean:5:warning', 'PW/LemB.lean:9:error']);
  });
  it('finds nothing in a clean build or in noise', () => {
    expect(parseBuild('Build completed successfully.\n')).toEqual([]);
    expect(parseBuild('')).toEqual([]);
    expect(parseBuild('error: no such file or directory')).toEqual([]);
  });
});

describe('markers', () => {
  it('reads block and rule markers with their lines', () => {
    const text = ['import PW.Defs', '', '-- pw: b12', 'inductive HasType where', '  -- pw: b12 r3', '  | tTrue : HasType', '--pw:b13', 'theorem x : True := trivial', '-- pw is nice', '-- pw: '].join('\n');
    expect(markers(text)).toEqual([{ line: 3, block: 'b12' }, { line: 5, block: 'b12', rule: 'r3' }, { line: 7, block: 'b13' }]);
  });
});

describe('scanning for sorry and axiom', () => {
  it('finds them in code', () => {
    const text = ['theorem a : P := by', '  sorry', 'axiom cheat : False', 'private axiom  hidden (n : Nat) : n = 0', 'theorem b : Q := by', '  intro h; admit'].join('\n');
    expect(scan(text)).toEqual({ sorries: [2, 6], axioms: [{ line: 3, name: 'cheat' }, { line: 4, name: 'hidden' }] });
  });
  it('ignores comments, nested block comments and strings', () => {
    const text = [
      '-- sorry, this is a comment about an axiom',
      '/- sorry',
      '   /- nested sorry -/',
      '   axiom fake : False -/',
      'def msg := "sorry \\" axiom x"',
      'theorem my_sorry_free : True := trivial',
      'theorem c : True := by sorry -- for now',
    ].join('\n');
    expect(scan(text)).toEqual({ sorries: [7], axioms: [] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lean-build.test.ts`
Expected: FAIL, cannot resolve `../src/lean/build`.

- [ ] **Step 3: Write the implementation**

`src/lean/build.ts`:

```ts
// Reading what a build left behind: Lake's diagnostics, the marker comments
// that tie Lean declarations to blocks of the document, and whether a file
// still holds a `sorry` or declares an axiom. Plain text in, plain data out.

import type { Id } from '../model/types';

export interface Diagnostic {
  /** Relative to the Lean folder, with forward slashes: PW/Defs.lean. */
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** `PW/Defs.lean` from however Lake wrote the path. */
function leanPath(p: string): string {
  const q = p.replace(/\\/g, '/');
  const at = q.lastIndexOf('/PW/');
  return at >= 0 ? q.slice(at + 1) : q.replace(/^(\.\/)+/, '');
}

// Lake 4.9 and later put the severity first; before that, Lean's own order showed through.
const SEVERITY_FIRST = /^(error|warning|info): (.+?\.lean):(\d+):(\d+): (.*)$/;
const PATH_FIRST = /^(.+?\.lean):(\d+):(\d+): (error|warning|info): (.*)$/;
/** Lines of Lake's own that end a diagnostic's message. */
const LAKE_LINE = /^(✖|✔|⚠|ℹ|trace: |error: |warning: |info: |Some required builds|Build completed|- PW)/;

export function parseBuild(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let open: Diagnostic | null = null;
  for (const line of output.split(/\r?\n/)) {
    const a = SEVERITY_FIRST.exec(line);
    const b = a ? null : PATH_FIRST.exec(line);
    if (a) open = { severity: a[1] as Diagnostic['severity'], file: leanPath(a[2]), line: +a[3], column: +a[4], message: a[5] };
    else if (b) open = { severity: b[4] as Diagnostic['severity'], file: leanPath(b[1]), line: +b[2], column: +b[3], message: b[5] };
    else {
      if (open && !LAKE_LINE.test(line) && line.trim() !== '') open.message += '\n' + line;
      else open = null;
      continue;
    }
    out.push(open);
  }
  return out;
}

export interface Marker { line: number; block: Id; rule?: Id }

const MARKER = /^\s*--\s*pw:\s*(\S+)(?:\s+(\S+))?\s*$/;

/** The `-- pw: <block> [<rule>]` comments of a Lean file, with 1-based lines. */
export function markers(text: string): Marker[] {
  const out: Marker[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = MARKER.exec(line);
    if (m) out.push(m[2] ? { line: i + 1, block: m[1], rule: m[2] } : { line: i + 1, block: m[1] });
  });
  return out;
}

/** The file with comments and string contents blanked, line breaks kept. */
function codeOnly(text: string): string {
  let out = '';
  let depth = 0;
  let i = 0;
  const blank = (c: string) => (c === '\n' ? '\n' : ' ');
  while (i < text.length) {
    if (text.startsWith('/-', i)) { depth++; out += '  '; i += 2; continue; }
    if (depth > 0) {
      if (text.startsWith('-/', i)) { depth--; out += '  '; i += 2; } else out += blank(text[i++]);
      continue;
    }
    if (text.startsWith('--', i)) {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (text[i] === '"') {
      out += ' ';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) { out += ' '; i++; }
        out += blank(text[i++]);
      }
      out += ' ';
      i++;
      continue;
    }
    out += text[i++];
  }
  return out;
}

export interface Scan { sorries: number[]; axioms: { line: number; name: string }[] }

const SORRY = /(?<![\w.])(sorry|admit)(?![\w])/;
const AXIOM = /^\s*(?:(?:private|protected|noncomputable|unsafe)\s+)*axiom\s+([^\s:({\[]+)/;

/** Lines (1-based) holding `sorry` or `admit`, and the axioms declared, outside comments and strings. */
export function scan(text: string): Scan {
  const out: Scan = { sorries: [], axioms: [] };
  codeOnly(text).split(/\r?\n/).forEach((line, i) => {
    if (SORRY.test(line)) out.sorries.push(i + 1);
    const m = AXIOM.exec(line);
    if (m) out.axioms.push({ line: i + 1, name: m[1] });
  });
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lean-build.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lean/build.ts tests/lean-build.test.ts
git commit -m "Parse lake build output, block markers and sorry/axiom in Lean files"
```

---

### Task 4: Deriving statuses from a build

**Files:**
- Create: `src/lean/derive.ts`
- Test: `tests/lean-derive.test.ts`

**Interfaces:**
- Consumes: `Item` (Task 1); `Finding`, `JobReport`, `MechBlock` (Task 2); `Diagnostic`, `markers`, `scan` (Task 3).
- Produces:
  - `interface DeriveInput { items: Item[]; cites: Map<Id, Id[]>; report: JobReport | null; diagnostics: Diagnostic[]; files: { path: string; text: string }[]; previous: Record<Id, MechBlock>; target?: Id }`
    - `cites` maps a statement's id to the ids of the statements its proof cites.
    - `target` is the statement a prove job was for; absent for a sync.
  - `derive(input: DeriveInput): Record<Id, MechBlock>`: one entry per item.

Rules the function implements (each has a test below):

1. An item with no marker in any file is Failed: "No Lean declaration was written for this block."
2. A build error at a line inside an item's region (its marker's line up to the line before the next marker for another block in that file) is a Stuck finding on that item and makes it Failed. An error above the first marker of a file belongs to every item in that file.
3. An `axiom` in a file makes every item in that file Failed.
4. A definition with none of the above is Translated.
5. If any definition is Failed, every statement is Failed: "Not checked: the definitions do not compile."
6. Otherwise a statement with `sorry` in its region, or a `declaration uses 'sorry'` warning there, is Stated; without, Proved.
7. A statement citing (directly or through others) a Failed statement is Failed: "Not checked: … does not compile." A Proved statement citing one that is only Stated lists it in `assumes`.
8. Findings from the report are attached to their block and to each block in `related`. After a prove job, other blocks keep their earlier deviations and inconsistencies.
9. `proofHash` is recorded when a statement is Proved: the item's, if this job proved it or none was recorded; otherwise the earlier one.

- [ ] **Step 1: Write the failing test**

`tests/lean-derive.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { derive, type DeriveInput } from '../src/lean/derive';
import type { Item } from '../src/lean/items';
import type { Diagnostic } from '../src/lean/build';

const def = (id: string): Item => ({ id, kind: 'rules', hash: 'h-' + id, hasProof: false, label: '', title: id });
const st = (id: string): Item => ({ id, kind: 'statement', hash: 'h-' + id, proofHash: 'p-' + id, hasProof: true, label: id, title: id, module: id.toUpperCase() });
const err = (file: string, line: number, message = 'boom'): Diagnostic => ({ file, line, column: 0, severity: 'error', message });

const DEFS = ['-- pw: syn', 'inductive Ty where', '  | bool', '', '-- pw: typ', 'inductive HasType where', '  -- pw: typ r1', '  | tTrue : HasType'].join('\n');
const proved = (id: string) => `import PW.Defs\n\n-- pw: ${id}\ntheorem ${id} : True := by\n  trivial\n`;
const stated = (id: string) => `import PW.Defs\n\n-- pw: ${id}\ntheorem ${id} : True := by\n  sorry\n`;

function input(over: Partial<DeriveInput> = {}): DeriveInput {
  return {
    items: [def('syn'), def('typ'), st('a'), st('b')],
    cites: new Map([['a', []], ['b', ['a']]]),
    report: null, diagnostics: [], previous: {},
    files: [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/B.lean', text: proved('b') }],
    ...over,
  };
}
const statuses = (i: DeriveInput) => Object.fromEntries(Object.entries(derive(i)).map(([id, b]) => [id, b.status]));

describe('deriving statuses', () => {
  it('calls a clean build translated and proved, and records where things are', () => {
    const out = derive(input());
    expect(statuses(input())).toEqual({ syn: 'translated', typ: 'translated', a: 'proved', b: 'proved' });
    expect(out.typ.file).toBe('PW/Defs.lean');
    expect(out.a).toMatchObject({ kind: 'statement', hash: 'h-a', proofHash: 'p-a', file: 'PW/A.lean', findings: [] });
    expect(out.b.assumes).toBeUndefined();
  });
  it('takes declaration names from the report', () => {
    const report = { outcome: 'done' as const, summary: '', blocks: [{ block: 'typ', file: 'PW/Defs.lean', names: ['HasType'] }], findings: [], proposals: [], changes: [] };
    expect(derive(input({ report })).typ.names).toEqual(['HasType']);
  });
  it('fails a block nothing was written for', () => {
    const out = derive(input({ items: [def('syn'), def('typ'), def('missing'), st('a')] }));
    expect(out.missing.status).toBe('failed');
    expect(out.missing.findings[0].message).toMatch(/No Lean declaration/);
  });
  it('pins a build error to the block whose region holds it', () => {
    const out = derive(input({ diagnostics: [err('PW/Defs.lean', 8, 'bad constructor')] }));
    expect(out.typ.status).toBe('failed');
    expect(out.typ.findings).toEqual([{ kind: 'stuck', block: 'typ', message: 'bad constructor', lean: { file: 'PW/Defs.lean', line: 8 } }]);
    expect(out.syn.status).toBe('translated');
  });
  it('gives an error above the first marker to every block of the file', () => {
    const text = 'import Nope\n' + DEFS;
    const out = derive(input({ files: [{ path: 'PW/Defs.lean', text }, { path: 'PW/A.lean', text: proved('a') }, { path: 'PW/B.lean', text: proved('b') }], diagnostics: [err('PW/Defs.lean', 1)] }));
    expect(out.syn.status).toBe('failed');
    expect(out.typ.status).toBe('failed');
  });
  it('does not check statements when a definition failed', () => {
    const out = derive(input({ diagnostics: [err('PW/Defs.lean', 2)] }));
    expect(out.a.status).toBe('failed');
    expect(out.a.findings[0].message).toMatch(/definitions do not compile/);
  });
  it('calls a statement with sorry stated, by scan or by the build warning', () => {
    const files = [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: stated('a') }, { path: 'PW/B.lean', text: proved('b') }];
    expect(statuses(input({ files })).a).toBe('stated');
    const warned = input({ diagnostics: [{ file: 'PW/A.lean', line: 4, column: 8, severity: 'warning', message: "declaration uses 'sorry'" }] });
    expect(statuses(warned).a).toBe('stated');
  });
  it('lists the unproved statements a proof rests on', () => {
    const files = [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: stated('a') }, { path: 'PW/B.lean', text: proved('b') }];
    const out = derive(input({ files }));
    expect(out.b.status).toBe('proved');
    expect(out.b.assumes).toEqual(['a']);
  });
  it('fails a statement citing a failed one, however clean its own file looks', () => {
    const out = derive(input({ diagnostics: [err('PW/A.lean', 5)] }));
    expect(out.a.status).toBe('failed');
    expect(out.b.status).toBe('failed');
    expect(out.b.findings[0].message).toMatch(/Not checked/);
  });
  it('survives a citation cycle', () => {
    expect(statuses(input({ cites: new Map([['a', ['b']], ['b', ['a']]]) }))).toMatchObject({ a: 'proved', b: 'proved' });
  });
  it('fails everything in a file that declares an axiom, and what cites it', () => {
    const files = [{ path: 'PW/Defs.lean', text: DEFS }, { path: 'PW/A.lean', text: proved('a') + 'axiom cheat : False\n' }, { path: 'PW/B.lean', text: proved('b') }];
    const out = derive(input({ files }));
    expect(out.a.status).toBe('failed');
    expect(out.a.findings[0].message).toMatch(/axiom.*cheat/);
    expect(out.b.status).toBe('failed');
  });
  it('attaches report findings to their block and to related blocks', () => {
    const report = { outcome: 'partial' as const, summary: '', blocks: [], proposals: [], changes: [], findings: [
      { kind: 'deviation' as const, block: 'a', message: 'extra hypothesis' },
      { kind: 'inconsistency' as const, block: 'b', related: ['typ'], message: 'rule and lemma disagree' },
    ] };
    const out = derive(input({ report }));
    expect(out.a.findings.map((f) => f.kind)).toEqual(['deviation']);
    expect(out.b.findings.map((f) => f.kind)).toEqual(['inconsistency']);
    expect(out.typ.findings.map((f) => f.kind)).toEqual(['inconsistency']);
  });
  it('keeps other blocks earlier deviations across a prove job, and drops their old stuck findings', () => {
    const previous = derive(input({ report: { outcome: 'done', summary: '', blocks: [], proposals: [], changes: [], findings: [{ kind: 'deviation', block: 'a', message: 'extra hypothesis' }, { kind: 'stuck', block: 'a', message: 'old' }] } }));
    const out = derive(input({ previous, target: 'b' }));
    expect(out.a.findings).toEqual([{ kind: 'deviation', block: 'a', message: 'extra hypothesis' }]);
    const afterSync = derive(input({ previous }));
    expect(afterSync.a.findings).toEqual([]);
  });
  it('records the proof hash of the job that proved it', () => {
    const previous = derive(input());
    const edited = input({ previous, target: 'b', items: [def('syn'), def('typ'), { ...st('a'), proofHash: 'p-a2' }, { ...st('b'), proofHash: 'p-b2' }] });
    const out = derive(edited);
    expect(out.a.proofHash).toBe('p-a');
    expect(out.b.proofHash).toBe('p-b2');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lean-derive.test.ts`
Expected: FAIL, cannot resolve `../src/lean/derive`.

- [ ] **Step 3: Write the implementation**

`src/lean/derive.ts`:

```ts
// What each block's status is after a build. Nothing here comes from what the
// agent says it did: the statuses follow from Lake's diagnostics, the marker
// comments and the text of the Lean files. The report only adds findings and
// the names of declarations.

import type { Id } from '../model/types';
import type { Item } from './items';
import type { Finding, JobReport, MechBlock } from './status';
import { markers, scan, type Diagnostic } from './build';

export interface DeriveInput {
  items: Item[];
  /** A statement's id to the ids of the statements its proof cites. */
  cites: Map<Id, Id[]>;
  report: JobReport | null;
  diagnostics: Diagnostic[];
  /** The Lean files after the build, paths relative to the Lean folder. */
  files: { path: string; text: string }[];
  previous: Record<Id, MechBlock>;
  /** The statement a prove job was for; absent for a sync. */
  target?: Id;
}

interface Place { file: string; regions: [number, number][]; firstMarker: number }

/** Where each block's declarations are: the file, and the line ranges from each of its markers to the next block's. */
function places(files: DeriveInput['files']): Map<Id, Place> {
  const out = new Map<Id, Place>();
  for (const f of files) {
    const ms = markers(f.text);
    ms.forEach((m, i) => {
      const next = ms.slice(i + 1).find((x) => x.block !== m.block);
      const region: [number, number] = [m.line, next ? next.line - 1 : Infinity];
      const p = out.get(m.block);
      if (!p) out.set(m.block, { file: f.path, regions: [region], firstMarker: ms[0].line });
      else if (p.file === f.path) p.regions.push(region);
    });
  }
  return out;
}

const within = (p: Place, line: number) => p.regions.some(([a, b]) => line >= a && line <= b);
const sameFinding = (a: Finding, b: Finding) => a.kind === b.kind && a.block === b.block && a.message === b.message;
const push = (list: Finding[], f: Finding) => { if (!list.some((x) => sameFinding(x, f))) list.push(f); };

export function derive(input: DeriveInput): Record<Id, MechBlock> {
  const { items, report, diagnostics, files, previous, target } = input;
  const where = places(files);
  const scans = new Map(files.map((f) => [f.path, scan(f.text)]));
  const out: Record<Id, MechBlock> = {};

  for (const item of items) {
    const p = where.get(item.id);
    const reported = report?.blocks.find((b) => b.block === item.id);
    const findings: Finding[] = [];
    // after a prove job the report is about one statement; what was learnt about the others still holds
    if (target && item.id !== target) for (const f of previous[item.id]?.findings ?? []) if (f.kind !== 'stuck') push(findings, f);
    for (const f of report?.findings ?? []) if (f.block === item.id || f.related?.includes(item.id)) push(findings, f);

    let failed = false;
    if (!p) {
      failed = true;
      push(findings, { kind: 'stuck', block: item.id, message: 'No Lean declaration was written for this block.' });
    } else {
      for (const d of diagnostics) {
        if (d.severity !== 'error' || d.file !== p.file) continue;
        if (!within(p, d.line) && d.line >= p.firstMarker) continue;
        failed = true;
        push(findings, { kind: 'stuck', block: item.id, message: d.message, lean: { file: d.file, line: d.line } });
      }
      for (const a of scans.get(p.file)?.axioms ?? []) {
        failed = true;
        push(findings, { kind: 'stuck', block: item.id, message: `${p.file} declares an axiom (${a.name}); nothing may be assumed without proof.`, lean: { file: p.file, line: a.line } });
      }
    }

    let status: MechBlock['status'] = failed ? 'failed' : 'translated';
    if (!failed && item.kind === 'statement' && p) {
      const hasSorry = (scans.get(p.file)?.sorries ?? []).some((l) => within(p, l))
        || diagnostics.some((d) => d.file === p.file && d.severity === 'warning' && /declaration uses 'sorry'/.test(d.message) && within(p, d.line));
      status = hasSorry ? 'stated' : 'proved';
    }
    out[item.id] = { kind: item.kind, hash: item.hash, file: reported?.file ?? p?.file ?? '', names: reported?.names ?? [], status, findings };
  }

  const statements = items.filter((i) => i.kind === 'statement');
  // Lake builds nothing that imports a file that failed, so a statement's own
  // file being clean says nothing once something it rests on is broken.
  if (items.some((i) => i.kind !== 'statement' && out[i.id].status === 'failed')) {
    for (const s of statements) {
      if (out[s.id].status === 'failed') continue;
      out[s.id].status = 'failed';
      push(out[s.id].findings, { kind: 'stuck', block: s.id, message: 'Not checked: the definitions do not compile.' });
    }
  }

  const title = new Map(items.map((i) => [i.id, i.title || i.label || i.id]));
  const ownFailure = new Set(statements.filter((s) => out[s.id].status === 'failed').map((s) => s.id));
  /** Everything a statement cites, directly or through others. */
  const reach = (id: Id, seen = new Set<Id>()): Set<Id> => {
    for (const c of input.cites.get(id) ?? []) {
      if (seen.has(c) || c === id || !out[c]) continue;
      seen.add(c);
      reach(c, seen);
    }
    return seen;
  };
  for (const s of statements) {
    const b = out[s.id];
    if (b.status === 'failed') continue;
    const cited = [...reach(s.id)].filter((c) => c !== s.id);
    const broken = cited.find((c) => ownFailure.has(c));
    if (broken) {
      b.status = 'failed';
      push(b.findings, { kind: 'stuck', block: s.id, message: `Not checked: ${title.get(broken)} does not compile.` });
      continue;
    }
    if (b.status !== 'proved') continue;
    const assumes = cited.filter((c) => out[c].status === 'stated');
    if (assumes.length) b.assumes = assumes;
    const earlier = previous[s.id]?.proofHash;
    b.proofHash = s.id === target || earlier === undefined ? s.proofHash : earlier;
  }
  return out;
}
```

Note on the cycle test: with `a` citing `b` and `b` citing `a`, `reach` visits each once and both stay Proved (the checker reports the cycle separately).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lean-derive.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lean/derive.ts tests/lean-derive.test.ts
git commit -m "Derive each block's Lean status from the build, not from the agent"
```

---

### Task 5: Proposals

**Files:**
- Create: `src/lean/proposals.ts`
- Test: `tests/lean-proposals.test.ts`

**Interfaces:**
- Consumes: `Doc`, `Block`, `Id` from `src/model/types.ts`; `walkBlocks` from `src/export/context.ts`; `Proposal`, `StoredProposal` (Task 2).
- Produces:
  - `currentText(doc: Doc, p: Proposal): string | null`: what the targeted field holds now; `''` for a premise one past the end; `null` when the target is gone.
  - `applies(doc: Doc, p: Proposal): boolean`
  - `applyProposal(doc: Doc, p: Proposal): boolean`: mutates `doc` (pass an immer draft); returns false and changes nothing when the proposal no longer applies.
  - `mergeProposals(old: StoredProposal[], fresh: Proposal[], scope: Id | null, newId: () => string): StoredProposal[]`: `scope` is the prove job's statement, or null for a sync.

- [ ] **Step 1: Write the failing test**

`tests/lean-proposals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applies, applyProposal, currentText, mergeProposals } from '../src/lean/proposals';
import type { Proposal, StoredProposal } from '../src/lean/status';
import type { Doc } from '../src/model/types';

function doc(): Doc {
  return {
    version: 1, title: 't', author: '', snippets: [], settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
    blocks: [
      { id: 'g', type: 'grammar', title: 'Syntax', rows: [{ id: 'row', category: 'Types', metavar: '\\tau', alternatives: ['Bool', 'Nat'] }] },
      { id: 'r', type: 'rules', title: 'Typing', rules: [{ id: 'r1', name: 'T-App', premises: ['p0', 'p1'], conclusion: 'c' }] },
      { id: 'thm', type: 'theorem', kind: 'lemma', title: '', label: 'lem:a', statement: 'Old statement.', proof: [{ id: 'txt', type: 'text', text: 'By induction.' }] },
    ],
  };
}
const p = (block: string, target: Proposal['target'], before: string, after: string): Proposal => ({ block, target, before, after, why: 'w' });

describe('what a proposal targets', () => {
  it('reads each kind of field, including one nested in a proof', () => {
    expect(currentText(doc(), p('thm', { field: 'statement' }, '', ''))).toBe('Old statement.');
    expect(currentText(doc(), p('txt', { field: 'text' }, '', ''))).toBe('By induction.');
    expect(currentText(doc(), p('r', { field: 'premise', rule: 'r1', index: 1 }, '', ''))).toBe('p1');
    expect(currentText(doc(), p('r', { field: 'conclusion', rule: 'r1' }, '', ''))).toBe('c');
    expect(currentText(doc(), p('r', { field: 'side', rule: 'r1' }, '', ''))).toBe('');
    expect(currentText(doc(), p('g', { field: 'alternative', row: 'row', index: 0 }, '', ''))).toBe('Bool');
  });
  it('treats a premise one past the end as empty, and anything further as gone', () => {
    expect(currentText(doc(), p('r', { field: 'premise', rule: 'r1', index: 2 }, '', ''))).toBe('');
    expect(currentText(doc(), p('r', { field: 'premise', rule: 'r1', index: 3 }, '', ''))).toBe(null);
  });
  it('is null when the block, rule or row is gone or of the wrong type', () => {
    expect(currentText(doc(), p('nope', { field: 'statement' }, '', ''))).toBe(null);
    expect(currentText(doc(), p('r', { field: 'statement' }, '', ''))).toBe(null);
    expect(currentText(doc(), p('r', { field: 'conclusion', rule: 'deleted' }, '', ''))).toBe(null);
    expect(currentText(doc(), p('g', { field: 'alternative', row: 'row', index: 9 }, '', ''))).toBe(null);
    expect(currentText(doc(), p('g', { field: 'alternative', row: 'deleted', index: 0 }, '', ''))).toBe(null);
  });
});

describe('applying a proposal', () => {
  it('replaces the field when it still holds the before text', () => {
    const d = doc();
    expect(applyProposal(d, p('thm', { field: 'statement' }, 'Old statement.', 'New statement.'))).toBe(true);
    expect(currentText(d, p('thm', { field: 'statement' }, '', ''))).toBe('New statement.');
  });
  it('adds, changes and removes premises, and sets a side condition', () => {
    const d = doc();
    applyProposal(d, p('r', { field: 'premise', rule: 'r1', index: 2 }, '', 'p2'));
    applyProposal(d, p('r', { field: 'premise', rule: 'r1', index: 0 }, 'p0', 'q0'));
    applyProposal(d, p('r', { field: 'premise', rule: 'r1', index: 1 }, 'p1', ''));
    applyProposal(d, p('r', { field: 'side', rule: 'r1' }, '', 'x \\notin \\Gamma'));
    const rule = (d.blocks[1] as Extract<Doc['blocks'][number], { type: 'rules' }>).rules[0];
    expect(rule.premises).toEqual(['q0', 'p2']);
    expect(rule.side).toBe('x \\notin \\Gamma');
  });
  it('does nothing when the field has moved on', () => {
    const d = doc();
    const before = JSON.stringify(d);
    const stale = p('thm', { field: 'statement' }, 'Something else.', 'New.');
    expect(applies(d, stale)).toBe(false);
    expect(applyProposal(d, stale)).toBe(false);
    expect(applyProposal(d, p('r', { field: 'conclusion', rule: 'deleted' }, 'c', 'd'))).toBe(false);
    expect(JSON.stringify(d)).toBe(before);
  });
});

describe('merging proposals after a job', () => {
  const stored = (id: string, block: string, after: string, state: StoredProposal['state']): StoredProposal => ({ ...p(block, { field: 'statement' }, 'a', after), id, state });
  let n = 0;
  const newId = () => `n${++n}`;
  it('after a sync, replaces open proposals and remembers dismissed ones', () => {
    const old = [stored('o1', 'thm', 'x', 'open'), stored('o2', 'thm', 'y', 'dismissed')];
    const out = mergeProposals(old, [p('thm', { field: 'statement' }, 'a', 'y'), p('thm', { field: 'statement' }, 'a', 'z')], null, newId);
    expect(out.map((q) => [q.after, q.state])).toEqual([['y', 'dismissed'], ['z', 'open']]);
  });
  it('after a prove job, keeps open proposals for other blocks', () => {
    const old = [stored('o1', 'other', 'x', 'open'), stored('o2', 'thm', 'y', 'open')];
    const out = mergeProposals(old, [p('thm', { field: 'statement' }, 'a', 'z')], 'thm', newId);
    expect(out.map((q) => [q.block, q.after])).toEqual([['other', 'x'], ['thm', 'z']]);
  });
  it('does not add the same proposal twice', () => {
    const fresh = p('thm', { field: 'statement' }, 'a', 'z');
    expect(mergeProposals([], [fresh, fresh], null, newId)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lean-proposals.test.ts`
Expected: FAIL, cannot resolve `../src/lean/proposals`.

- [ ] **Step 3: Write the implementation**

`src/lean/proposals.ts`:

```ts
// Edits to the document that a job proposes. One proposal changes one field,
// and only while that field still reads as it did when the proposal was made:
// the user may have rewritten it since.

import type { Block, Doc, Id } from '../model/types';
import { walkBlocks } from '../export/context';
import type { Proposal, StoredProposal } from './status';

function find(doc: Doc, id: Id): Block | null {
  let found: Block | null = null;
  walkBlocks(doc.blocks, (b) => { if (b.id === id && !found) found = b; });
  return found;
}

/** A way to read and write the targeted field; null when the target is gone. */
function field(doc: Doc, p: Proposal): { get: () => string; set: (v: string) => void } | null {
  const b = find(doc, p.block);
  if (!b) return null;
  const t = p.target;
  if (t.field === 'statement') return b.type === 'theorem' ? { get: () => b.statement, set: (v) => { b.statement = v; } } : null;
  if (t.field === 'text') return b.type === 'text' ? { get: () => b.text, set: (v) => { b.text = v; } } : null;
  if (t.field === 'alternative') {
    const row = b.type === 'grammar' ? b.rows.find((r) => r.id === t.row) : undefined;
    const i = t.index ?? -1;
    if (!row || i < 0 || i >= row.alternatives.length) return null;
    return { get: () => row.alternatives[i], set: (v) => { row.alternatives[i] = v; } };
  }
  const rule = b.type === 'rules' ? b.rules.find((r) => r.id === t.rule) : undefined;
  if (!rule) return null;
  if (t.field === 'conclusion') return { get: () => rule.conclusion, set: (v) => { rule.conclusion = v; } };
  if (t.field === 'side') return { get: () => rule.side ?? '', set: (v) => { if (v) rule.side = v; else delete rule.side; } };
  const i = t.index ?? -1;
  if (i < 0 || i > rule.premises.length) return null;
  return {
    get: () => rule.premises[i] ?? '',
    // an empty premise is no premise: proposing '' removes it
    set: (v) => { if (v) rule.premises[i] = v; else rule.premises.splice(i, 1); },
  };
}

/** What the targeted field holds now; '' for a premise one past the end; null when the target is gone. */
export function currentText(doc: Doc, p: Proposal): string | null {
  return field(doc, p)?.get() ?? null;
}

export const applies = (doc: Doc, p: Proposal) => currentText(doc, p) === p.before;

/** Makes the edit in place (give it an immer draft). False, and nothing changed, when it no longer applies. */
export function applyProposal(doc: Doc, p: Proposal): boolean {
  const f = field(doc, p);
  if (!f || f.get() !== p.before) return false;
  f.set(p.after);
  return true;
}

const same = (a: Proposal, b: Proposal) => a.block === b.block && a.after === b.after && JSON.stringify(a.target) === JSON.stringify(b.target);

/**
 * The proposals to keep after a job. Ones the user settled stay, so a
 * dismissed one is not offered again. Open ones the job could have revisited
 * (all of them after a sync; the statement's own after a proof) give way to
 * what the job proposes now.
 */
export function mergeProposals(old: StoredProposal[], fresh: Proposal[], scope: Id | null, newId: () => string): StoredProposal[] {
  const out = old.filter((p) => p.state !== 'open' || (scope !== null && p.block !== scope));
  for (const p of fresh) {
    if (out.some((q) => same(q, p))) continue;
    out.push({ ...p, id: newId(), state: 'open' });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lean-proposals.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/lean/proposals.ts tests/lean-proposals.test.ts
git commit -m "Apply a proposed document edit only while its field is unchanged"
```

---

### Task 6: The snapshot, the prompts and the agent's instructions

**Files:**
- Create: `src/lean/snapshot.ts`
- Create: `src/lean/prompt.ts`
- Create: `electron/lean-instructions.md`
- Test: `tests/lean-prompt.test.ts`

**Interfaces:**
- Consumes: `Item`, `Staleness` (Task 1); `FINDING_KINDS`, `PROPOSAL_FIELDS`, `OUTCOMES` (Task 2).
- Produces:
  - `docMarkdown(doc: Doc): string`: the document as Markdown with every block, rule, grammar row and case id shown.
  - `MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const`, `EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const`
  - `REPORT_SCHEMA`: a JSON Schema object for `JobReport`.
  - `syncPrompt(a: { items: Item[]; stale: Staleness; cites: Map<Id, Id[]>; first: boolean }): string`
  - `provePrompt(a: { item: Item; cited: Item[] }): string`
  - `electron/lean-instructions.md`: the text written to `CLAUDE.md`.

- [ ] **Step 1: Write the failing test**

`tests/lean-prompt.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { docItems, staleness } from '../src/lean/items';
import { EFFORTS, MODELS, REPORT_SCHEMA, provePrompt, syncPrompt } from '../src/lean/prompt';
import { docMarkdown } from '../src/lean/snapshot';
import { FINDING_KINDS, OUTCOMES, PROPOSAL_FIELDS } from '../src/lean/status';
import { sampleDoc } from '../src/model/sample';
import type { Doc } from '../src/model/types';

const instructions = readFileSync(new URL('../electron/lean-instructions.md', import.meta.url), 'utf8');

const doc: Doc = {
  version: 1, title: 'Tiny', author: '', settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
  snippets: [{ id: 's', kind: 'math', name: 'ty', arity: 3, body: '#1 \\vdash #2 : #3' }],
  blocks: [
    { id: 'h', type: 'heading', level: 1, text: 'Typing' },
    { id: 'g', type: 'grammar', title: 'Syntax', rows: [{ id: 'row', category: 'Types', metavar: '\\tau', alternatives: ['\\mathsf{Bool}'] }] },
    { id: 'r', type: 'rules', title: 'Typing', judgment: '\\ty{\\Gamma}{e}{\\tau}', rules: [{ id: 'r1', name: 'T-True', premises: ['p'], conclusion: 'c', side: 's' }] },
    { id: 'a', type: 'theorem', kind: 'lemma', title: 'Canonical forms', label: 'lem:canonical', statement: 'Values of type Bool are booleans.', proof: [
      { id: 'cs', type: 'cases', intro: 'By cases.', cases: [{ id: 'c1', title: 'Case [[T-True]]', body: [{ id: 't', type: 'text', text: 'Immediate.' }] }] },
    ] },
    { id: 'b', type: 'theorem', kind: 'theorem', title: 'Progress', label: 'thm:progress', statement: 'Well-typed terms step.', proof: [{ id: 't2', type: 'text', text: 'By [[lem:canonical]].' }] },
  ],
};

describe('the snapshot in Markdown', () => {
  const md = docMarkdown(doc);
  it('shows every id an agent may need to name', () => {
    for (const id of ['g', 'row', 'r', 'r1', 'a', 'cs', 'c1', 't', 'b']) expect(md).toContain('`' + id + '`');
  });
  it('shows macros, rules and statements as written', () => {
    expect(md).toContain('\\ty');
    expect(md).toContain('#1 \\vdash #2 : #3');
    expect(md).toContain('T-True');
    expect(md).toContain('Lemma 1 (Canonical forms)');
    expect(md).toContain('Theorem 2 (Progress)');
    expect(md).toContain('Values of type Bool are booleans.');
  });
  it('handles the sample document', () => {
    expect(docMarkdown(sampleDoc()).length).toBeGreaterThan(500);
  });
});

describe('the job prompts', () => {
  const items = docItems(doc);
  const cites = new Map([['a', []], ['b', ['a']]]);
  it('names every statement, its module and what it imports', () => {
    const p = syncPrompt({ items, stale: staleness(items, {}), cites, first: true });
    expect(p).toContain('PW/LemCanonical.lean');
    expect(p).toContain('PW/ThmProgress.lean');
    expect(p).toContain('PW.LemCanonical');
    expect(p).toMatch(/nothing has been translated/i);
  });
  it('lists what changed, appeared and went away on a later sync', () => {
    const recorded = Object.fromEntries(items.filter((i) => i.id !== 'g').map((i) => [i.id, { hash: i.id === 'r' ? 'old' : i.hash, kind: i.kind }]));
    recorded.gone = { hash: 'x', kind: 'statement' };
    const p = syncPrompt({ items, stale: staleness(items, recorded), cites, first: false });
    expect(p).toMatch(/Changed.*`r`/);
    expect(p).toMatch(/New.*`g`/);
    expect(p).toMatch(/Deleted.*`gone`/);
  });
  it('asks for one proof and says what may be cited', () => {
    const p = provePrompt({ item: items.find((i) => i.id === 'b')!, cited: [items.find((i) => i.id === 'a')!] });
    expect(p).toContain('`b`');
    expect(p).toContain('PW/ThmProgress.lean');
    expect(p).toContain('PW.LemCanonical');
  });
});

describe('the instructions and the report schema', () => {
  it('agree on every word a report may use', () => {
    for (const word of [...FINDING_KINDS, ...PROPOSAL_FIELDS, ...OUTCOMES]) expect(instructions).toContain('`' + word + '`');
    expect(REPORT_SCHEMA.properties.findings.items.properties.kind.enum).toEqual([...FINDING_KINDS]);
    expect(REPORT_SCHEMA.properties.proposals.items.properties.target.properties.field.enum).toEqual([...PROPOSAL_FIELDS]);
    expect(REPORT_SCHEMA.properties.outcome.enum).toEqual([...OUTCOMES]);
  });
  it('state the rules a job is held to', () => {
    for (const phrase of ['-- pw:', 'PW/Defs.lean', 'axiom', 'sorry', 'document.json', 'CONVENTIONS.md', 'lake build']) expect(instructions).toContain(phrase);
  });
  it('offer the models and efforts the CLI takes', () => {
    expect(MODELS).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lean-prompt.test.ts`
Expected: FAIL, cannot resolve `../src/lean/prompt`.

- [ ] **Step 3: Write the snapshot**

`src/lean/snapshot.ts`:

```ts
// The document as an agent reads it: Markdown with the math left in LaTeX and
// the id of every block, rule, grammar row and case shown, since those ids
// are how a job says which part of the document it means.

import type { Block, Doc, ProofNode } from '../model/types';
import { THEOREM_LABEL } from '../model/types';

function tree(n: ProofNode, depth: number, out: string[]) {
  const rule = n.rule ? ` [${n.rule}]` : n.leaf ? ' [assumption]' : n.elided ? ' [derivation elided]' : '';
  out.push(`${'  '.repeat(depth)}- $${n.judgment}$${rule}`);
  for (const c of n.children) tree(c, depth + 1, out);
}

export function docMarkdown(doc: Doc): string {
  const out: string[] = [`# ${doc.title || 'Untitled'}`, ''];
  const math = doc.snippets.filter((s) => s.kind === 'math' && s.name);
  const text = doc.snippets.filter((s) => s.kind === 'text' && s.name);
  if (math.length) {
    out.push('## Math macros', '', 'Math below is LaTeX and uses these macros.', '');
    for (const s of math) out.push(`- \`\\${s.name}\` (${s.arity} argument${s.arity === 1 ? '' : 's'}): \`${s.body}\`${s.description ? ` (${s.description})` : ''}`);
    out.push('');
  }
  if (text.length) {
    out.push('## Text snippets', '', 'Written `{{name}}` in prose.', '');
    for (const s of text) out.push(`- \`{{${s.name}}}\`: ${s.body}`);
    out.push('');
  }

  const counters = new Map<string, number>();
  const number = (kind: keyof typeof THEOREM_LABEL) => {
    const key = doc.settings.numberTheorems === 'shared' ? 'thm' : kind;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return `${THEOREM_LABEL[kind]} ${n}`;
  };

  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      switch (b.type) {
        case 'heading': out.push(`${'#'.repeat(b.level + 1)} ${b.text}`, ''); break;
        case 'text': out.push(`(text block \`${b.id}\`)`, '', b.text, ''); break;
        case 'grammar':
          out.push(`**Grammar${b.title ? `: ${b.title}` : ''}** (block \`${b.id}\`)`, '');
          for (const r of b.rows) out.push(`- ${r.category || '(no category)'}, row \`${r.id}\`: $${r.metavar}$ ::= ${r.alternatives.map((a) => `$${a}$`).join(' | ')}`);
          out.push('');
          break;
        case 'rules':
          out.push(`**Rules${b.title ? `: ${b.title}` : ''}** (block \`${b.id}\`)${b.judgment ? `, judgment form $${b.judgment}$` : ''}`, '');
          for (const r of b.rules) {
            out.push(`- Rule ${r.name || '(unnamed)'} (rule \`${r.id}\`)`);
            r.premises.forEach((p, i) => out.push(`  - premise ${i}: $${p}$`));
            out.push(`  - conclusion: $${r.conclusion}$`);
            if (r.side) out.push(`  - side condition: $${r.side}$`);
          }
          out.push('');
          break;
        case 'derivation': {
          out.push(`**Proof tree** (block \`${b.id}\`)${b.caption ? `: ${b.caption}` : ''}`, '');
          tree(b.root, 0, out);
          out.push('');
          break;
        }
        case 'theorem': {
          const name = number(b.kind);
          out.push(`**${name}${b.title ? ` (${b.title})` : ''}** (block \`${b.id}\`${b.label ? `, label \`${b.label}\`` : ''})`, '', b.statement, '');
          if (b.proof?.length) {
            out.push(b.kind === 'definition' ? '*Part of this definition:*' : '*Proof.*', '');
            walk(b.proof);
            out.push(b.kind === 'definition' ? `*End of ${name}.*` : `*End of the proof of ${name}.*`, '');
          }
          break;
        }
        case 'cases':
          out.push(`(case analysis \`${b.id}\`) ${b.intro}`, '');
          for (const c of b.cases) {
            out.push(`*${c.title || 'Case'}* (case \`${c.id}\`)`, '');
            walk(c.body);
          }
          out.push(`(end of case analysis \`${b.id}\`)`, '');
          break;
        case 'raw': out.push(`(raw Typst/LaTeX block \`${b.id}\`, not shown)`, ''); break;
      }
    }
  };
  walk(doc.blocks);
  return out.join('\n');
}
```

- [ ] **Step 4: Write the prompts and the schema**

`src/lean/prompt.ts`:

```ts
// What a job is told and what it must answer with. The standing rules are in
// electron/lean-instructions.md (CLAUDE.md in the Lean folder); a prompt only
// names the job. Along with that file and electron/lean.cjs, this is all the
// code that knows the prover is Lean.

import type { Id } from '../model/types';
import type { Item, Staleness } from './items';
import { FINDING_KINDS, OUTCOMES, PROPOSAL_FIELDS } from './status';

/** The CLI's model aliases; each follows the latest model of that name. */
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Model = (typeof MODELS)[number];
export type Effort = (typeof EFFORTS)[number];

const text = { type: 'string' } as const;

/** JSON Schema of a job's final answer (JobReport in status.ts). */
export const REPORT_SCHEMA = {
  type: 'object',
  required: ['outcome', 'summary', 'blocks', 'findings', 'proposals', 'changes'],
  properties: {
    outcome: { type: 'string', enum: [...OUTCOMES] },
    summary: text,
    blocks: {
      type: 'array',
      items: { type: 'object', required: ['block', 'file', 'names'], properties: { block: text, file: text, names: { type: 'array', items: text } } },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['kind', 'block', 'message'],
        properties: {
          kind: { type: 'string', enum: [...FINDING_KINDS] },
          block: text,
          at: text,
          related: { type: 'array', items: text },
          message: text,
          lean: { type: 'object', required: ['file', 'line'], properties: { file: text, line: { type: 'integer' } } },
        },
      },
    },
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        required: ['block', 'target', 'before', 'after', 'why'],
        properties: {
          block: text,
          target: {
            type: 'object',
            required: ['field'],
            properties: { field: { type: 'string', enum: [...PROPOSAL_FIELDS] }, rule: text, row: text, index: { type: 'integer' } },
          },
          before: text,
          after: text,
          why: text,
        },
      },
    },
    changes: {
      type: 'array',
      items: { type: 'object', required: ['file', 'name', 'change'], properties: { file: text, name: text, change: { type: 'string', enum: ['added', 'changed', 'removed'] } } },
    },
  },
};

const ids = (xs: Iterable<Id>) => [...xs].map((x) => '`' + x + '`').join(', ');
const named = (i: Item) => `\`${i.id}\`${i.label ? ` (${i.label})` : i.title ? ` (${i.title})` : ''}`;

export function syncPrompt(a: { items: Item[]; stale: Staleness; cites: Map<Id, Id[]>; first: boolean }): string {
  const byId = new Map(a.items.map((i) => [i.id, i]));
  const defs = a.items.filter((i) => i.kind !== 'statement');
  const statements = a.items.filter((i) => i.kind === 'statement');
  const lines = ['Job: sync. Bring the Lean definitions and the Lean statements up to date with document.json, as your instructions for this folder describe.', ''];
  if (a.first) lines.push('Nothing has been translated yet: this is the first sync.');
  else {
    lines.push('Since the last sync:');
    if (a.stale.stale.size) lines.push(`- Changed blocks: ${ids(a.stale.stale)}`);
    if (a.stale.fresh.size) lines.push(`- New blocks: ${ids(a.stale.fresh)}`);
    if (a.stale.deleted.length) lines.push(`- Deleted blocks: ${ids(a.stale.deleted)} (remove their declarations, and delete a deleted statement's file)`);
    if (!a.stale.stale.size && !a.stale.fresh.size && !a.stale.deleted.length) lines.push('- Nothing is recorded as changed; check that every block below has its declaration and that the project builds.');
  }
  lines.push('', 'Definitions, all in PW/Defs.lean, in this order:');
  for (const d of defs) lines.push(`- ${named(d)}: ${d.kind}`);
  if (!defs.length) lines.push('- (none)');
  lines.push('', 'Statements, one file each, in this order:');
  for (const s of statements) {
    const imports = (a.cites.get(s.id) ?? []).map((c) => byId.get(c)?.module).filter(Boolean).map((m) => `PW.${m}`);
    lines.push(`- ${named(s)}: PW/${s.module}.lean${imports.length ? `, also imports ${imports.join(', ')}` : ''}`);
  }
  if (!statements.length) lines.push('- (none)');
  lines.push('', 'State every statement and leave `sorry` as the proof of any that has no proof yet. Keep an existing proof where it still compiles. Do not attempt new proofs in this job.');
  return lines.join('\n');
}

export function provePrompt(a: { item: Item; cited: Item[] }): string {
  const lines = [
    `Job: prove. Replace the \`sorry\` in PW/${a.item.module}.lean with a proof of the statement from block ${named(a.item)}, following the written proof in document.json as your instructions for this folder describe.`,
    '',
    'Edit that file only.',
  ];
  if (a.cited.length) lines.push('', 'The written proof cites these statements, which the file may import and use whether or not they are proved yet:', ...a.cited.map((c) => `- ${named(c)}: PW.${c.module}`));
  return lines.join('\n');
}
```

- [ ] **Step 5: Write the instructions**

`electron/lean-instructions.md`:

````markdown
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
````

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/lean-prompt.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lean/snapshot.ts src/lean/prompt.ts electron/lean-instructions.md tests/lean-prompt.test.ts
git commit -m "Write the agent's instructions, job prompts and document snapshot"
```

---

### Task 7: The main-process side: tools, project files, running Claude and Lake

**Files:**
- Create: `electron/lean.cjs`
- Test: `tests/lean-electron.test.ts`

**Interfaces:**
- Consumes: `electron/lean-instructions.md` (Task 6).
- Produces (all exported from `electron/lean.cjs`):
  - `MODELS: string[]`, `EFFORTS: string[]`
  - `leanDir(docPath: string): string`
  - `findTool(name: string, opts?: { env?, home?, system? }): Promise<string | null>`; `system` is the list of system-wide directories searched last (tests pass `[]`).
  - `findTools(opts?): Promise<{ claude: string | null; lake: string | null }>`
  - `childEnv(tools, opts?: { env?, home?, system? }): object`: an environment whose PATH reaches both tools.
  - `ensureProject(dir, lake, env): Promise<void>`
  - `recreateProject(dir, lake, env): Promise<void>`
  - `writeInstructions(dir): Promise<string>`: writes `CLAUDE.md`, returns its text followed by the text of `CONVENTIONS.md`.
  - `writeSnapshot(dir, { json, md }): Promise<void>`
  - `claudeArgs({ model, effort, schema, instructions }): string[]`: throws on an unlisted model or effort.
  - `runClaude({ claude, dir, prompt, args, env, onLine?, limitMs? }): { done: Promise<{ ok: boolean; report: unknown; cancelled: boolean; error?: string }>; cancel(): void }`
  - `runBuild({ dir, lake, env, limitMs? }): Promise<{ started: boolean; code: number | null; output: string; files: { path: string; text: string }[] }>`
  - `readStatus(dir): Promise<unknown | null>`, `writeStatus(dir, status): Promise<void>`

- [ ] **Step 1: Write the failing test**

`tests/lean-electron.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { EFFORTS, MODELS } from '../src/lean/prompt';

const lean = createRequire(import.meta.url)('../electron/lean.cjs');

// Stand-ins for the two programs, driven by FAKE_CLAUDE.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  fs.writeFileSync('prompt.txt', input);
  const mode = process.env.FAKE_CLAUDE || 'ok';
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  say({ type: 'system', subtype: 'init' });
  process.stdout.write('this line is not JSON\\n');
  say({ type: 'assistant', message: { content: [
    { type: 'tool_use', name: 'Write', input: { file_path: process.cwd() + '/PW/Defs.lean' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'lake build' } },
  ] } });
  if (mode === 'noreport') { process.stderr.write('first line\\nNot logged in\\n'); process.exitCode = 3; return; }
  const result = JSON.stringify(mode === 'error'
    ? { type: 'result', is_error: true, result: 'Credit balance is too low' }
    : { type: 'result', is_error: false, result: '', structured_output: { outcome: 'done', summary: 'ok' } }) + '\\n';
  process.stdout.write(result.slice(0, 20));
  await new Promise((r) => setTimeout(r, 40));
  process.stdout.write(result.slice(20));
});
`;
const FAKE_LAKE = `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('Lake version 5.0.0-src (Lean version 4.22.0)'); process.exit(0); }
console.log("error: ././././PW/Defs.lean:2:0: unknown identifier 'x'");
console.error('error: build failed');
process.exitCode = 1;
`;

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pw-lean-')));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const [name, text] of [['claude', FAKE_CLAUDE], ['lake', FAKE_LAKE]] as const) {
    writeFileSync(join(bin, name), text);
    chmodSync(join(bin, name), 0o755);
  }
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH };
  const dir = lean.leanDir(join(root, 'stlc.proof.json'));
  return { root, bin, env, dir, claude: join(bin, 'claude'), lake: join(bin, 'lake') };
}
const args = () => lean.claudeArgs({ model: '', effort: '', schema: { type: 'object' }, instructions: 'RULES' });

describe.skipIf(process.platform === 'win32')('the Lean side of the desktop app', () => {
  it('names the Lean folder after the document', () => {
    expect(lean.leanDir('/docs/stlc.proof.json')).toBe('/docs/stlc-lean');
    expect(lean.leanDir('/docs/My Notes.json')).toBe('/docs/My Notes-lean');
    expect(lean.leanDir('/docs/a.b.proof.json')).toBe('/docs/a.b-lean');
  });

  it('finds tools on the PATH and in the places a GUI app does not inherit', async () => {
    const { root, bin } = setup();
    expect(await lean.findTool('lake', { env: { PATH: bin }, home: root, system: [] })).toBe(join(bin, 'lake'));
    expect(await lean.findTool('lake', { env: { PATH: '' }, home: root, system: [] })).toBe(null);
    mkdirSync(join(root, '.elan', 'bin'), { recursive: true });
    writeFileSync(join(root, '.elan', 'bin', 'lake'), FAKE_LAKE);
    chmodSync(join(root, '.elan', 'bin', 'lake'), 0o755);
    expect(await lean.findTool('lake', { env: { PATH: '' }, home: root, system: [] })).toBe(join(root, '.elan', 'bin', 'lake'));
    const env = lean.childEnv({ claude: join(bin, 'claude'), lake: join(root, '.elan', 'bin', 'lake') }, { env: { PATH: '/usr/bin' }, home: root, system: [] });
    expect(env.PATH.split(delimiter).slice(0, 2)).toEqual([join(root, '.elan', 'bin'), bin]);
  });

  it('creates the project once and leaves the user’s conventions alone', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    expect(readFileSync(join(dir, 'lakefile.toml'), 'utf8')).toContain('name = "PW"');
    expect(readFileSync(join(dir, 'lean-toolchain'), 'utf8').trim()).toBe('leanprover/lean4:v4.22.0');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('.lake');
    expect(existsSync(join(dir, 'PW'))).toBe(true);
    writeFileSync(join(dir, 'CONVENTIONS.md'), 'Use de Bruijn indices.');
    writeFileSync(join(dir, 'lean-toolchain'), 'leanprover/lean4:v4.20.0\n');
    await lean.ensureProject(dir, lake, env);
    expect(readFileSync(join(dir, 'CONVENTIONS.md'), 'utf8')).toBe('Use de Bruijn indices.');
    expect(readFileSync(join(dir, 'lean-toolchain'), 'utf8').trim()).toBe('leanprover/lean4:v4.20.0');
  });

  it('rewrites CLAUDE.md before a job and hands back both instruction files', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    writeFileSync(join(dir, 'CLAUDE.md'), 'tampered');
    writeFileSync(join(dir, 'CONVENTIONS.md'), 'Use de Bruijn indices.');
    const text = await lean.writeInstructions(dir);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('-- pw:');
    expect(text).toContain('-- pw:');
    expect(text).toContain('Use de Bruijn indices.');
  });

  it('recreates the project files without touching PW/', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    writeFileSync(join(dir, 'PW', 'Defs.lean'), '-- mine');
    writeFileSync(join(dir, 'lakefile.toml'), 'broken');
    await lean.recreateProject(dir, lake, env);
    expect(readFileSync(join(dir, 'lakefile.toml'), 'utf8')).toContain('name = "PW"');
    expect(readFileSync(join(dir, 'PW', 'Defs.lean'), 'utf8')).toBe('-- mine');
  });

  it('builds the command line, with the model and effort only when chosen', () => {
    const plain = args();
    for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--verbose', '--no-session-persistence']) expect(plain).toContain(flag);
    expect(plain[plain.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(plain[plain.indexOf('--permission-prompts') + 1]).toBe('none');
    expect(plain[plain.indexOf('--append-system-prompt') + 1]).toBe('RULES');
    expect(JSON.parse(plain[plain.indexOf('--json-schema') + 1])).toEqual({ type: 'object' });
    expect(plain).toContain('Bash(lake build)');
    expect(plain).not.toContain('--model');
    expect(plain).not.toContain('--effort');
    const chosen = lean.claudeArgs({ model: 'opus', effort: 'high', schema: {}, instructions: '' });
    expect(chosen[chosen.indexOf('--model') + 1]).toBe('opus');
    expect(chosen[chosen.indexOf('--effort') + 1]).toBe('high');
  });

  it('refuses a model or effort that is not on the list', () => {
    expect(() => lean.claudeArgs({ model: 'opus; rm -rf ~', effort: '', schema: {}, instructions: '' })).toThrow(/model/);
    expect(() => lean.claudeArgs({ model: '', effort: 'extreme', schema: {}, instructions: '' })).toThrow(/effort/);
    expect(lean.MODELS).toEqual([...MODELS]);
    expect(lean.EFFORTS).toEqual([...EFFORTS]);
  });

  it('runs a job to its report, and survives split and non-JSON lines', async () => {
    const { dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env);
    const lines: string[] = [];
    const run = lean.runClaude({ claude, dir, prompt: 'Job: sync.', args: args(), env, onLine: (l: string) => lines.push(l) });
    expect(await run.done).toEqual({ ok: true, report: { outcome: 'done', summary: 'ok' }, cancelled: false });
    expect(lines).toEqual(['wrote PW/Defs.lean', 'lake build']);
    expect(readFileSync(join(dir, 'prompt.txt'), 'utf8')).toBe('Job: sync.');
    expect(JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8'))).toEqual(args());
  });

  it('reports a run that ends without a report, with the CLI’s last words', async () => {
    const { dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env);
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: { ...env, FAKE_CLAUDE: 'noreport' } });
    expect(await run.done).toEqual({ ok: false, report: null, cancelled: false, error: 'Not logged in' });
  });

  it('reports a run the CLI marks as an error', async () => {
    const { dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env);
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: { ...env, FAKE_CLAUDE: 'error' } });
    expect(await run.done).toMatchObject({ ok: false, cancelled: false, error: 'Credit balance is too low' });
  });

  it('cancels a running job, and stops one that runs past its limit', async () => {
    const { dir, lake, env, claude } = setup();
    await lean.ensureProject(dir, lake, env);
    const hang = { ...env, FAKE_CLAUDE: 'hang' };
    const run = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: hang });
    setTimeout(() => run.cancel(), 150);
    expect(await run.done).toMatchObject({ ok: false, cancelled: true });
    const slow = lean.runClaude({ claude, dir, prompt: 'x', args: args(), env: hang, limitMs: 150 });
    expect(await slow.done).toMatchObject({ ok: false, cancelled: false, error: expect.stringMatching(/time limit/) });
  });

  it('says so when claude cannot be started', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    const run = lean.runClaude({ claude: join(dir, 'no-such-claude'), dir, prompt: 'x', args: args(), env });
    expect(await run.done).toMatchObject({ ok: false, error: expect.stringMatching(/Could not start/) });
  });

  it('builds, returning Lake’s output and the Lean files, and keeps PW.lean in step', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    writeFileSync(join(dir, 'PW', 'LemA.lean'), 'import PW.Defs\n');
    writeFileSync(join(dir, 'PW', 'Defs.lean'), '-- pw: b1\n');
    writeFileSync(join(dir, 'PW', 'notes.txt'), 'ignore me');
    const built = await lean.runBuild({ dir, lake, env });
    expect(built.started).toBe(true);
    expect(built.code).toBe(1);
    expect(built.output).toContain("unknown identifier 'x'");
    expect(built.output).toContain('build failed');
    expect(built.files).toEqual([{ path: 'PW/Defs.lean', text: '-- pw: b1\n' }, { path: 'PW/LemA.lean', text: 'import PW.Defs\n' }]);
    expect(readFileSync(join(dir, 'PW.lean'), 'utf8')).toBe('import PW.Defs\nimport PW.LemA\n');
  });

  it('says a build did not start when lake is missing', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    expect(await lean.runBuild({ dir, lake: join(dir, 'no-such-lake'), env })).toMatchObject({ started: false, code: null });
  });

  it('writes the status file whole and reads back null for anything unreadable', async () => {
    const { dir } = setup();
    expect(await lean.readStatus(dir)).toBe(null);
    await lean.writeStatus(dir, { version: 1, blocks: {}, proposals: [] });
    expect(await lean.readStatus(dir)).toEqual({ version: 1, blocks: {}, proposals: [] });
    expect(existsSync(join(dir, 'mechanization.json.tmp'))).toBe(false);
    writeFileSync(join(dir, 'mechanization.json'), '{ "version": 1, "blo');
    expect(await lean.readStatus(dir)).toBe(null);
  });

  it('writes the snapshot', async () => {
    const { dir, lake, env } = setup();
    await lean.ensureProject(dir, lake, env);
    await lean.writeSnapshot(dir, { json: '{"version":1}', md: '# Doc' });
    expect(readFileSync(join(dir, 'document.json'), 'utf8')).toBe('{"version":1}');
    expect(readFileSync(join(dir, 'document.md'), 'utf8')).toBe('# Doc');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/lean-electron.test.ts`
Expected: FAIL, cannot find module `../electron/lean.cjs`.

- [ ] **Step 3: Write the implementation**

`electron/lean.cjs`:

```js
// Mechanizing a document in Lean: the Lake project beside the document, the
// headless Claude Code run that writes its Lean files, and the build that
// says what compiled. What the results mean is decided in src/lean; this file
// only finds the programs, keeps the project's fixed files, and runs things.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const JOB_LIMIT_MS = 30 * 60 * 1000;
const BUILD_LIMIT_MS = 10 * 60 * 1000;
const WINDOWS = process.platform === 'win32';

const LAKEFILE = `name = "PW"
version = "0.1.0"
defaultTargets = ["PW"]

[[lean_lib]]
name = "PW"
`;

const CONVENTIONS = `# Conventions for this mechanization

This file is yours. Proof Writer creates it once and never changes it; the
agent reads it after its standing instructions in CLAUDE.md.

Write here how you want this document mechanized, for example:

- how variables and binders are represented (de Bruijn indices, names, ...)
- how typing contexts are represented (lists, functions, ...)
- naming, or Lean style you prefer
`;

/** The Lean folder of a document: `stlc.proof.json` and `stlc.json` both give `stlc-lean` beside them. */
function leanDir(docPath) {
  const base = path.basename(docPath).replace(/\.json$/i, '').replace(/\.proof$/i, '');
  return path.join(path.dirname(docPath), `${base}-lean`);
}

// A packaged app is not started from a shell, so its PATH lacks the places
// these tools are usually installed to.
const SYSTEM_DIRS = WINDOWS ? [] : ['/usr/local/bin', '/opt/homebrew/bin'];

function searchPath({ env = process.env, home = os.homedir(), system = SYSTEM_DIRS } = {}) {
  const extra = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.elan', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    ...(WINDOWS && env.APPDATA ? [path.join(env.APPDATA, 'npm')] : []),
    ...system,
  ];
  return [...(env.PATH ?? '').split(path.delimiter), ...extra].filter(Boolean);
}

async function findTool(name, opts) {
  for (const dir of searchPath(opts)) {
    for (const ext of WINDOWS ? ['.exe', '.cmd'] : ['']) {
      const p = path.join(dir, name + ext);
      try {
        await fs.access(p, constants.X_OK);
        if ((await fs.stat(p)).isFile()) return p;
      } catch { /* not here */ }
    }
  }
  return null;
}

async function findTools(opts) {
  return { claude: await findTool('claude', opts), lake: await findTool('lake', opts) };
}

/** An environment in which a job finds `lake`, and Lake finds `lean`. */
function childEnv(tools, opts = {}) {
  const first = [tools.lake, tools.claude].filter(Boolean).map((p) => path.dirname(p));
  return { ...(opts.env ?? process.env), PATH: [...new Set([...first, ...searchPath(opts)])].join(path.delimiter) };
}

/** The toolchain to pin: the one `lake` runs now, so the project keeps building after an update. */
function toolchain(lake, env) {
  return new Promise((resolve) => {
    execFile(lake, ['--version'], { env, shell: WINDOWS }, (err, stdout) => {
      const m = err ? null : /Lean version ([0-9][^\s,)]*)/.exec(String(stdout));
      resolve(`leanprover/lean4:${m ? 'v' + m[1] : 'stable'}`);
    });
  });
}

async function writeIfMissing(file, text) {
  try { await fs.writeFile(file, text, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

/** Makes the Lean folder a Lake project, creating only what is not there. */
async function ensureProject(dir, lake, env) {
  await fs.mkdir(path.join(dir, 'PW'), { recursive: true });
  await writeIfMissing(path.join(dir, 'lakefile.toml'), LAKEFILE);
  if (!(await exists(path.join(dir, 'lean-toolchain')))) await writeIfMissing(path.join(dir, 'lean-toolchain'), (await toolchain(lake, env)) + '\n');
  await writeIfMissing(path.join(dir, '.gitignore'), '.lake/\n');
  await writeIfMissing(path.join(dir, 'CONVENTIONS.md'), CONVENTIONS);
}

/** The Lean files under PW/, definitions first, as paths relative to the folder. */
async function leanFiles(dir) {
  let names = [];
  try { names = await fs.readdir(path.join(dir, 'PW')); } catch { /* no PW yet */ }
  return names
    .filter((n) => n.endsWith('.lean'))
    .sort((a, b) => (a === 'Defs.lean' ? -1 : b === 'Defs.lean' ? 1 : a.localeCompare(b)))
    .map((n) => `PW/${n}`);
}

/** Writes PW.lean to import every module there is, so a build covers them all. */
async function writeRoot(dir) {
  const files = await leanFiles(dir);
  await fs.writeFile(path.join(dir, 'PW.lean'), files.map((f) => `import PW.${path.basename(f, '.lean')}\n`).join(''));
  return files;
}

/** Puts back the files that make the folder a project, leaving PW/ as it is. */
async function recreateProject(dir, lake, env) {
  await fs.mkdir(path.join(dir, 'PW'), { recursive: true });
  await fs.writeFile(path.join(dir, 'lakefile.toml'), LAKEFILE);
  await fs.writeFile(path.join(dir, 'lean-toolchain'), (await toolchain(lake, env)) + '\n');
  await writeRoot(dir);
}

/**
 * Writes the agent's standing instructions as CLAUDE.md, for sessions the
 * user opens in the folder, and returns them with the user's conventions
 * appended: a job runs in restricted mode, which does not read CLAUDE.md, so
 * it is given the text directly.
 */
async function writeInstructions(dir) {
  const text = await fs.readFile(path.join(__dirname, 'lean-instructions.md'), 'utf8');
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), text);
  let conventions = '';
  try { conventions = await fs.readFile(path.join(dir, 'CONVENTIONS.md'), 'utf8'); } catch { /* none */ }
  return `${text}\n\n# CONVENTIONS.md\n\n${conventions}`;
}

async function writeSnapshot(dir, { json, md }) {
  await fs.writeFile(path.join(dir, 'document.json'), json);
  await fs.writeFile(path.join(dir, 'document.md'), md);
}

/**
 * The command line of a job. Restricted mode confines the file tools to the
 * Lean folder and ignores the user's settings and plugins; the allow list
 * lets Bash run Lake and nothing else; with nobody to answer a permission
 * prompt, anything else is refused.
 */
function claudeArgs({ model, effort, schema, instructions }) {
  if (model && !MODELS.includes(model)) throw new Error(`Unknown model: ${model}`);
  if (effort && !EFFORTS.includes(effort)) throw new Error(`Unknown effort: ${effort}`);
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--restricted', '--strict-mcp-config', '--no-session-persistence',
    '--permission-prompts', 'none',
    '--tools', 'Bash,Read,Edit,Write,Glob,Grep',
    '--allowedTools', 'Bash(lake build)', 'Bash(lake build *)', 'Bash(lake env lean *)', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    '--json-schema', JSON.stringify(schema),
    '--append-system-prompt', instructions,
  ];
}

/** What to show for one event of the stream: the files written and the commands run. */
function activity(event, dir) {
  if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  const rel = (p) => {
    if (typeof p !== 'string') return '';
    const r = path.relative(dir, p);
    return r.startsWith('..') ? path.basename(p) : r.split(path.sep).join('/');
  };
  const lines = [];
  for (const c of event.message.content) {
    if (c?.type !== 'tool_use') continue;
    const input = c.input ?? {};
    if (c.name === 'Write') lines.push(`wrote ${rel(input.file_path)}`);
    else if (c.name === 'Edit') lines.push(`edited ${rel(input.file_path)}`);
    else if (c.name === 'Read') lines.push(`read ${rel(input.file_path)}`);
    else if (c.name === 'Bash') lines.push(String(input.command ?? '').slice(0, 120));
    else if (c.name === 'StructuredOutput') lines.push('writing the report');
  }
  return lines;
}

/** Starts a job. `done` never rejects; `cancel` stops the job. */
function runClaude({ claude, dir, prompt, args, env, onLine = () => {}, limitMs = JOB_LIMIT_MS }) {
  const child = spawn(claude, args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'], shell: WINDOWS });
  let cancelled = false;
  let timedOut = false;
  let result = null;
  let buffer = '';
  let stderr = '';
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, limitMs);

  // The stream is one JSON object per line, but a chunk may end mid-line and
  // a line may not be JSON at all (a warning printed by something underneath).
  const take = (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (event?.type === 'result') result = event;
    for (const l of activity(event, dir)) onLine(l);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      take(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });

  const done = new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, report: null, cancelled: false, error: `Could not start claude: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      take(buffer);
      if (cancelled) resolve({ ok: false, report: null, cancelled: true, error: 'Cancelled.' });
      else if (timedOut) resolve({ ok: false, report: null, cancelled: false, error: 'Stopped: the job ran past its time limit.' });
      else if (!result) resolve({ ok: false, report: null, cancelled: false, error: stderr.trim().split('\n').pop() || `claude exited with code ${code}` });
      else if (result.is_error) resolve({ ok: false, report: result.structured_output ?? null, cancelled: false, error: (typeof result.result === 'string' && result.result) || 'The run ended with an error.' });
      else resolve({ ok: true, report: result.structured_output ?? null, cancelled: false });
    });
  });
  child.stdin.on('error', () => { /* the process went away before reading the prompt; `close` reports it */ });
  child.stdin.end(prompt);
  return { done, cancel: () => { cancelled = true; child.kill(); } };
}

/** Runs `lake build` and returns what it printed with the Lean files as they now are. */
async function runBuild({ dir, lake, env, limitMs = BUILD_LIMIT_MS }) {
  const paths = await writeRoot(dir);
  const ran = await new Promise((resolve) => {
    let output = '';
    const child = spawn(lake, ['build'], { cwd: dir, env, shell: WINDOWS });
    const timer = setTimeout(() => child.kill(), limitMs);
    child.stdout.on('data', (c) => { output += c; });
    child.stderr.on('data', (c) => { output += c; });
    child.on('error', (err) => { clearTimeout(timer); resolve({ started: false, code: null, output: err.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ started: true, code, output }); });
  });
  const files = [];
  for (const p of paths) files.push({ path: p, text: await fs.readFile(path.join(dir, p), 'utf8') });
  return { ...ran, files };
}

/** What mechanization.json holds, or null if it is missing or not JSON. */
async function readStatus(dir) {
  try { return JSON.parse(await fs.readFile(path.join(dir, 'mechanization.json'), 'utf8')); } catch { return null; }
}

/** Replaces mechanization.json in one step, so a crash never leaves half a file. */
async function writeStatus(dir, status) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'mechanization.json');
  await fs.writeFile(file + '.tmp', JSON.stringify(status, null, 2));
  await fs.rename(file + '.tmp', file);
}

module.exports = {
  MODELS, EFFORTS, leanDir, findTool, findTools, childEnv, ensureProject, recreateProject,
  writeInstructions, writeSnapshot, claudeArgs, runClaude, runBuild, readStatus, writeStatus,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/lean-electron.test.ts`
Expected: all tests PASS.

If "runs a job to its report" fails on the `lines` expectation with a path like `Defs.lean` in place of `PW/Defs.lean`, the temp directory was not resolved: check that `setup()` wraps `mkdtempSync` in `realpathSync` (on macOS `/var` is a link to `/private/var`).

- [ ] **Step 5: Check the real CLI still accepts the command line**

The fake proves the plumbing, not the flags. Run the real thing once, in a throwaway folder, with the cheapest model:

```bash
REPO=$(pwd) && T=$(mktemp -d) && cd "$T" && node -e '
const lean = require(process.argv[1]);
(async () => {
  const tools = await lean.findTools();
  if (!tools.claude) { console.log("claude not found; skip"); return; }
  const args = lean.claudeArgs({ model: "haiku", effort: "", instructions: "The word is PINEAPPLE.",
    schema: { type: "object", required: ["word"], properties: { word: { type: "string" } } } });
  const run = lean.runClaude({ claude: tools.claude, dir: process.cwd(), env: lean.childEnv(tools), args,
    prompt: "What is the word? Then try to run `ls ..` with Bash and ignore the result.", onLine: (l) => console.log("activity:", l) });
  console.log(JSON.stringify(await run.done));
})();' "$REPO/electron/lean.cjs"; cd "$REPO"
```

Run it from the repository root.

Expected: a line `{"ok":true,"report":{"word":"PINEAPPLE"},"cancelled":false}`. If the CLI rejects a flag, fix `claudeArgs` and its test before going on; `claude --help` lists the current flags.

- [ ] **Step 6: Commit**

```bash
git add electron/lean.cjs tests/lean-electron.test.ts
git commit -m "Run Claude Code and Lake for a document's Lean folder"
```

---

### Task 8: The bridge between the window and the main process

**Files:**
- Modify: `electron/main.cjs` (add a require near line 9; add handlers after the `workspace-reveal` handler, near line 159)
- Modify: `electron/preload.cjs` (add a `lean` group after `workspace`)
- Modify: `src/util/desktop.ts` (add types and the `lean` member of `DesktopBridge`)

**Interfaces:**
- Consumes: everything `electron/lean.cjs` exports (Task 7).
- Produces, in `src/util/desktop.ts`:
  - `interface LeanTools { claude: string | null; lake: string | null }`
  - `interface LeanRunResult { ok: boolean; report: unknown; cancelled: boolean; error?: string }`
  - `interface LeanBuildResult { started: boolean; code: number | null; output: string; files: { path: string; text: string }[] }`
  - `interface LeanBridge { tools(): Promise<LeanTools>; open(docPath: string): Promise<{ dir: string; status: unknown }>; run(job: { docPath: string; prompt: string; snapshot: { json: string; md: string }; schema: unknown; model: string; effort: string }): Promise<LeanRunResult>; cancel(): Promise<void>; build(docPath: string): Promise<LeanBuildResult>; writeStatus(docPath: string, status: unknown): Promise<void>; recreate(docPath: string): Promise<void>; reveal(docPath: string): Promise<void>; onEvent(cb: (e: { line: string }) => void): () => void }`
  - `DesktopBridge.lean: LeanBridge`

There is no unit test for IPC wiring in this codebase (the existing handlers have none); this task is verified by the type check, the build and Task 10's manual run.

- [ ] **Step 1: Add the handlers to the main process**

In `electron/main.cjs`, after `const workspace = require('./workspace.cjs');` add:

```js
const lean = require('./lean.cjs');
```

After the `ipcMain.handle('workspace-reveal', ...)` line add:

```js
// ---------- mechanization in Lean ----------
// A window may work only in the Lean folder of the document it has open, which
// is the one it is watching.
function leanFolder(e, docPath) {
  if (!docPath || watchers.get(e.sender.id)?.path !== docPath) throw new Error('That is not the document this window has open.');
  return lean.leanDir(docPath);
}
/** The job each window is running, if any. */
const leanRuns = new Map();

ipcMain.handle('lean-tools', () => lean.findTools());
ipcMain.handle('lean-open', async (e, docPath) => {
  const dir = leanFolder(e, docPath);
  return { dir, status: await lean.readStatus(dir) };
});
ipcMain.handle('lean-run', async (e, { docPath, prompt, snapshot, schema, model, effort }) => {
  const sender = e.sender;
  const id = sender.id;
  if (leanRuns.has(id)) throw new Error('A job is already running in this window.');
  const dir = leanFolder(e, docPath);
  const tools = await lean.findTools();
  if (!tools.claude || !tools.lake) throw new Error('Claude Code or Lean was not found.');
  const env = lean.childEnv(tools);
  const args = lean.claudeArgs({ model, effort, schema, instructions: '' });
  await lean.ensureProject(dir, tools.lake, env);
  await lean.writeSnapshot(dir, snapshot);
  args[args.length - 1] = await lean.writeInstructions(dir);
  const run = lean.runClaude({ claude: tools.claude, dir, prompt, args, env, onLine: (line) => { if (!sender.isDestroyed()) sender.send('lean-event', { line }); } });
  leanRuns.set(id, run);
  // a window closed mid-job takes its job with it
  sender.once('destroyed', run.cancel);
  try {
    return await run.done;
  } finally {
    leanRuns.delete(id);
    if (!sender.isDestroyed()) sender.removeListener('destroyed', run.cancel);
  }
});
ipcMain.handle('lean-cancel', (e) => { leanRuns.get(e.sender.id)?.cancel(); });
ipcMain.handle('lean-build', async (e, docPath) => {
  const dir = leanFolder(e, docPath);
  const tools = await lean.findTools();
  if (!tools.lake) return { started: false, code: null, output: 'lake was not found.', files: [] };
  return lean.runBuild({ dir, lake: tools.lake, env: lean.childEnv(tools) });
});
ipcMain.handle('lean-write-status', (e, { docPath, status }) => lean.writeStatus(leanFolder(e, docPath), status));
ipcMain.handle('lean-recreate', async (e, docPath) => {
  const dir = leanFolder(e, docPath);
  const tools = await lean.findTools();
  if (!tools.lake) throw new Error('lake was not found.');
  await lean.recreateProject(dir, tools.lake, lean.childEnv(tools));
});
ipcMain.handle('lean-reveal', async (e, docPath) => { await shell.openPath(leanFolder(e, docPath)); });
```

`claudeArgs` is called before anything is written so an unlisted model or effort is refused without touching the disk; its last element is the instructions text, filled in once the file is written.

- [ ] **Step 2: Expose the bridge**

In `electron/preload.cjs`, after the closing `},` of the `workspace` group and before `onMenu`, add:

```js
  lean: {
    tools: () => ipcRenderer.invoke('lean-tools'),
    open: (docPath) => ipcRenderer.invoke('lean-open', docPath),
    run: (job) => ipcRenderer.invoke('lean-run', job),
    cancel: () => ipcRenderer.invoke('lean-cancel'),
    build: (docPath) => ipcRenderer.invoke('lean-build', docPath),
    writeStatus: (docPath, status) => ipcRenderer.invoke('lean-write-status', { docPath, status }),
    recreate: (docPath) => ipcRenderer.invoke('lean-recreate', docPath),
    reveal: (docPath) => ipcRenderer.invoke('lean-reveal', docPath),
    onEvent: (cb) => {
      const h = (_e, f) => cb(f);
      ipcRenderer.on('lean-event', h);
      return () => ipcRenderer.removeListener('lean-event', h);
    },
  },
```

- [ ] **Step 3: Type the bridge**

In `src/util/desktop.ts`, after the `FolderListing` interface add:

```ts
/** Where the two programs a mechanization needs were found; null for one that was not. */
export interface LeanTools { claude: string | null; lake: string | null }
/** How a job ended. `report` is whatever the agent answered with, unchecked. */
export interface LeanRunResult { ok: boolean; report: unknown; cancelled: boolean; error?: string }
/** A build's output and the Lean files as they are after it, paths relative to the Lean folder. */
export interface LeanBuildResult { started: boolean; code: number | null; output: string; files: { path: string; text: string }[] }

/** Mechanizing the window's document in Lean (electron/lean.cjs). Every call is confined to that document's Lean folder. */
export interface LeanBridge {
  tools(): Promise<LeanTools>;
  /** The Lean folder's path and what its mechanization.json holds (null if there is none). */
  open(docPath: string): Promise<{ dir: string; status: unknown }>;
  /** Runs Claude Code in the Lean folder, creating the project first if needed. Resolves when the run ends. */
  run(job: { docPath: string; prompt: string; snapshot: { json: string; md: string }; schema: unknown; model: string; effort: string }): Promise<LeanRunResult>;
  cancel(): Promise<void>;
  build(docPath: string): Promise<LeanBuildResult>;
  writeStatus(docPath: string, status: unknown): Promise<void>;
  /** Rewrites the files that make the folder a Lake project, leaving the Lean sources alone. */
  recreate(docPath: string): Promise<void>;
  reveal(docPath: string): Promise<void>;
  /** Activity of the running job, a line at a time. */
  onEvent(cb: (e: { line: string }) => void): () => void;
}
```

and inside `DesktopBridge`, after the `workspace: { ... };` member, add:

```ts
  lean: LeanBridge;
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && node -e "require('./electron/lean.cjs')" && npx vitest run`
Expected: no type errors, no output from node, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/main.cjs electron/preload.cjs src/util/desktop.ts
git commit -m "Expose the Lean folder of a window's document to the renderer"
```

---

### Task 9: The tab's rows, and running a job from the renderer

**Files:**
- Create: `src/lean/view.ts`
- Create: `src/lean/job.ts`
- Create: `src/lean/store.ts`
- Test: `tests/lean-view.test.ts`
- Test: `tests/lean-job.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 6; `LeanBridge`, `LeanRunResult`, `LeanBuildResult`, `LeanTools`, `desktop` from `src/util/desktop.ts` (Task 8); `checkDoc` from `src/check`; `useStore` from `src/store.ts`.
- Produces:
  - `src/lean/view.ts`:
    - `type RowStatus = 'none' | 'stale' | 'translated' | 'stated' | 'proved' | 'deviations' | 'failed'`
    - `interface LeanProposal extends StoredProposal { applicable: boolean }`
    - `interface LeanRow { id: Id; item: Item; status: RowStatus; assumes: Id[]; proofChanged: boolean; canProve: boolean; file: string; findings: Finding[]; proposals: LeanProposal[] }`
    - `interface LeanView { definitions: LeanRow[]; statements: LeanRow[]; byId: Map<Id, LeanRow>; outOfDate: number; needsSync: boolean; loose: LeanProposal[] }`
    - `owners(doc: Doc, itemIds: ReadonlySet<Id>): Map<Id, Id>`: each block's enclosing item (an item owns itself).
    - `leanView(doc: Doc, mech: Mechanization): LeanView`: cached on the identity of its two arguments.
  - `src/lean/job.ts`:
    - `interface JobDeps { bridge: LeanBridge; doc: Doc; docPath: string; mech: Mechanization; model: string; effort: string; now?: () => Date; newId?: () => string; onPhase?: (kind: 'sync' | 'prove') => void }`
    - `interface JobResult { mech: Mechanization; ok: boolean; error: string | null }`
    - `performJob(d: JobDeps, kind: 'sync' | 'prove', target?: Id): Promise<JobResult>`
    - `proveWithSync(d: JobDeps, target: Id): Promise<JobResult>`
  - `src/lean/store.ts`: `useLean`, a zustand store with state `{ docPath, tools, dir, mech, job, error, model, effort, focus }` and actions `load(docPath)`, `checkTools()`, `sync()`, `prove(id)`, `cancel()`, `settle(proposalId, accept)`, `recreate()`, `reveal()`, `setModel(m)`, `setEffort(e)`, `show(id)`.

- [ ] **Step 1: Write the failing tests**

`tests/lean-view.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { docItems } from '../src/lean/items';
import { leanView, owners } from '../src/lean/view';
import type { MechBlock, Mechanization } from '../src/lean/status';
import type { Doc } from '../src/model/types';

function doc(statementA = 'S'): Doc {
  return {
    version: 1, title: 't', author: '', snippets: [], settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
    blocks: [
      { id: 'r', type: 'rules', title: 'Typing', rules: [{ id: 'r1', name: 'T-True', premises: [], conclusion: 'c' }] },
      { id: 'a', type: 'theorem', kind: 'lemma', title: 'A', label: 'lem:a', statement: statementA, proof: [{ id: 'ta', type: 'text', text: 'Easy.' }] },
      { id: 'b', type: 'theorem', kind: 'theorem', title: 'B', label: 'thm:b', statement: 'S', proof: [] },
      { id: 'c', type: 'theorem', kind: 'conjecture', title: 'C', label: 'conj:c', statement: 'S', proof: [{ id: 'tc', type: 'text', text: 'Maybe.' }] },
      { id: 'loose', type: 'text', text: 'Remark.' },
    ],
  };
}
function mech(d: Doc, over: Record<string, Partial<MechBlock>> = {}, proposals: Mechanization['proposals'] = []): Mechanization {
  const blocks: Mechanization['blocks'] = {};
  for (const i of docItems(d)) {
    blocks[i.id] = { kind: i.kind, hash: i.hash, proofHash: i.proofHash, file: 'PW/x.lean', names: [], status: i.kind === 'statement' ? 'proved' : 'translated', findings: [], ...over[i.id] };
  }
  return { version: 1, blocks, proposals };
}
const status = (d: Doc, m: Mechanization) => Object.fromEntries([...leanView(d, m).byId].map(([id, r]) => [id, r.status]));

describe('the rows of the Lean tab', () => {
  it('are all untranslated before the first sync', () => {
    const v = leanView(doc(), { version: 1, blocks: {}, proposals: [] });
    expect(v.definitions.map((r) => r.id)).toEqual(['r']);
    expect(v.statements.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(v.statements.every((r) => r.status === 'none')).toBe(true);
    expect(v.outOfDate).toBe(4);
    expect(v.needsSync).toBe(true);
  });
  it('show what the status file records when nothing changed', () => {
    const d = doc();
    const v = leanView(d, mech(d, { b: { status: 'stated' }, c: { status: 'failed' } }));
    expect(status(d, mech(d, { b: { status: 'stated' }, c: { status: 'failed' } }))).toEqual({ r: 'translated', a: 'proved', b: 'stated', c: 'failed' });
    expect(v.needsSync).toBe(false);
  });
  it('offer Prove for a statement with a written proof that is not a conjecture', () => {
    const d = doc();
    expect(leanView(d, mech(d)).statements.map((r) => r.canProve)).toEqual([true, false, false]);
  });
  it('mark an edited statement out of date, alone', () => {
    const d = doc();
    const m = mech(d);
    expect(status(doc('Changed.'), m)).toMatchObject({ r: 'translated', a: 'stale', b: 'proved' });
  });
  it('mark every statement out of date when a definition changed', () => {
    const d = doc();
    const m = mech(d);
    const edited = doc();
    (edited.blocks[0] as Extract<Doc['blocks'][number], { type: 'rules' }>).rules[0].conclusion = 'other';
    expect(status(edited, m)).toEqual({ r: 'stale', a: 'stale', b: 'stale', c: 'stale' });
  });
  it('need a sync when a translated block was deleted', () => {
    const d = doc();
    const m = mech(d);
    const fewer = { ...d, blocks: d.blocks.filter((b) => b.id !== 'c') };
    expect(leanView(fewer, m).needsSync).toBe(true);
  });
  it('call a proof with a recorded deviation proved with deviations, and pass on what it assumes', () => {
    const d = doc();
    const m = mech(d, { a: { assumes: ['b'], findings: [{ kind: 'deviation', block: 'a', message: 'extra hypothesis' }] } });
    const row = leanView(d, m).byId.get('a')!;
    expect(row.status).toBe('deviations');
    expect(row.assumes).toEqual(['b']);
  });
  it('note a written proof edited since it was proved', () => {
    const d = doc();
    const m = mech(d);
    const edited = doc();
    (edited.blocks[1] as Extract<Doc['blocks'][number], { type: 'theorem' }>).proof = [{ id: 'ta', type: 'text', text: 'Harder than it looked.' }];
    const row = leanView(edited, m).byId.get('a')!;
    expect(row.status).toBe('proved');
    expect(row.proofChanged).toBe(true);
  });
  it('put open proposals under the item that owns their block, and say which still apply', () => {
    const d = doc();
    const proposals: Mechanization['proposals'] = [
      { id: 'p1', state: 'open', block: 'ta', target: { field: 'text' }, before: 'Easy.', after: 'By induction.', why: 'w' },
      { id: 'p2', state: 'open', block: 'a', target: { field: 'statement' }, before: 'Not the text', after: 'x', why: 'w' },
      { id: 'p3', state: 'dismissed', block: 'a', target: { field: 'statement' }, before: 'S', after: 'y', why: 'w' },
      { id: 'p4', state: 'open', block: 'loose', target: { field: 'text' }, before: 'Remark.', after: 'Note.', why: 'w' },
    ];
    const v = leanView(d, mech(d, {}, proposals));
    expect(v.byId.get('a')!.proposals.map((p) => [p.id, p.applicable])).toEqual([['p1', true], ['p2', false]]);
    expect(v.loose.map((p) => p.id)).toEqual(['p4']);
  });
  it('return the same view for the same document and status', () => {
    const d = doc();
    const m = mech(d);
    expect(leanView(d, m)).toBe(leanView(d, m));
  });
});

describe('owners', () => {
  it('map a block inside a proof to its statement, and an item to itself', () => {
    const d = doc();
    const own = owners(d, new Set(docItems(d).map((i) => i.id)));
    expect(own.get('ta')).toBe('a');
    expect(own.get('a')).toBe('a');
    expect(own.has('loose')).toBe(false);
  });
});
```

`tests/lean-job.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { performJob, proveWithSync, type JobDeps } from '../src/lean/job';
import { REPORT_SCHEMA } from '../src/lean/prompt';
import { emptyMechanization } from '../src/lean/status';
import type { LeanBridge, LeanBuildResult, LeanRunResult } from '../src/util/desktop';
import type { Doc } from '../src/model/types';

const doc: Doc = {
  version: 1, title: 't', author: '', snippets: [], settings: { paper: 'a4', fontSize: 11, numberTheorems: 'shared' },
  blocks: [
    { id: 'r', type: 'rules', title: 'Typing', rules: [{ id: 'r1', name: 'T-True', premises: [], conclusion: 'c' }] },
    { id: 'a', type: 'theorem', kind: 'lemma', title: 'A', label: 'lem:a', statement: 'S', proof: [{ id: 'ta', type: 'text', text: 'Easy.' }] },
    { id: 'b', type: 'theorem', kind: 'theorem', title: 'B', label: 'thm:b', statement: 'S', proof: [{ id: 'tb', type: 'text', text: 'By [[lem:a]].' }] },
  ],
};
const DEFS = { path: 'PW/Defs.lean', text: '-- pw: r\ninductive T where\n  -- pw: r r1\n  | t : T\n' };
const file = (module: string, id: string, proof: string) => ({ path: `PW/${module}.lean`, text: `import PW.Defs\n\n-- pw: ${id}\ntheorem ${id} : True := by\n  ${proof}\n` });
const STATED = [DEFS, file('LemA', 'a', 'sorry'), file('ThmB', 'b', 'sorry')];
const B_PROVED = [DEFS, file('LemA', 'a', 'sorry'), file('ThmB', 'b', 'trivial')];
const built = (files: LeanBuildResult['files'], output = ''): LeanBuildResult => ({ started: true, code: output ? 1 : 0, output, files });
const ok = (report: unknown = { outcome: 'done', summary: 'Done.' }): LeanRunResult => ({ ok: true, report, cancelled: false });

function fake(runs: LeanRunResult[], builds: LeanBuildResult[]) {
  const calls: string[] = [];
  const written: unknown[] = [];
  const jobs: Parameters<LeanBridge['run']>[0][] = [];
  const next = <T,>(list: T[]) => (list.length > 1 ? list.shift()! : list[0]);
  const bridge: LeanBridge = {
    tools: async () => ({ claude: 'claude', lake: 'lake' }),
    open: async () => ({ dir: '/d', status: null }),
    run: async (job) => { calls.push('run'); jobs.push(job); return next(runs); },
    cancel: async () => {},
    build: async () => { calls.push('build'); return next(builds); },
    writeStatus: async (_p, s) => { calls.push('write'); written.push(s); },
    recreate: async () => {},
    reveal: async () => {},
    onEvent: () => () => {},
  };
  return { bridge, calls, written, jobs };
}
let n = 0;
const deps = (bridge: LeanBridge, over: Partial<JobDeps> = {}): JobDeps =>
  ({ bridge, doc, docPath: '/docs/t.json', mech: emptyMechanization(), model: 'opus', effort: 'high', now: () => new Date('2026-10-12T10:00:00Z'), newId: () => `p${++n}`, ...over });

describe('a sync', () => {
  it('runs Claude, builds, and records statuses from the build', async () => {
    const f = fake([ok()], [built(STATED)]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(f.calls).toEqual(['run', 'build', 'write']);
    expect(f.jobs[0].prompt).toMatch(/^Job: sync/);
    expect(f.jobs[0].prompt).toContain('PW/ThmB.lean');
    expect(JSON.parse(f.jobs[0].snapshot.json)).toEqual(doc);
    expect(f.jobs[0].snapshot.md).toContain('T-True');
    expect(f.jobs[0].schema).toBe(REPORT_SCHEMA);
    expect([f.jobs[0].model, f.jobs[0].effort]).toEqual(['opus', 'high']);
    expect(r.ok).toBe(true);
    expect(Object.fromEntries(Object.entries(r.mech.blocks).map(([id, b]) => [id, b.status]))).toEqual({ r: 'translated', a: 'stated', b: 'stated' });
    expect(r.mech.lastJob).toEqual({ kind: 'sync', endedAt: '2026-10-12T10:00:00.000Z', model: 'opus', effort: 'high', outcome: 'done', summary: 'Done.', changes: [] });
    expect(f.written).toEqual([r.mech]);
  });
  it('does not take the agent’s word for it', async () => {
    const f = fake([ok({ outcome: 'done', summary: 'All proved!' })], [built(STATED, "error: ././././PW/Defs.lean:2:0: unknown identifier 'x'")]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r.mech.blocks.r.status).toBe('failed');
    expect(r.mech.blocks.a.status).toBe('failed');
  });
  it('moves a finding about a block inside a proof to the statement, keeping where it was', async () => {
    const report = { outcome: 'partial', summary: '', findings: [{ kind: 'stuck', block: 'tb', message: 'This step does not follow.' }, { kind: 'stuck', block: 'nowhere', message: 'x' }] };
    const r = await performJob(deps(fake([ok(report)], [built(STATED)]).bridge), 'sync');
    expect(r.mech.blocks.b.findings).toEqual([{ kind: 'stuck', block: 'b', at: 'tb', message: 'This step does not follow.' }]);
  });
  it('stores proposals with ids, open', async () => {
    const report = { outcome: 'partial', summary: '', proposals: [{ block: 'a', target: { field: 'statement' }, before: 'S', after: 'S, for closed terms', why: 'Needed in the base case.' }] };
    const r = await performJob(deps(fake([ok(report)], [built(STATED)]).bridge), 'sync');
    expect(r.mech.proposals).toHaveLength(1);
    expect(r.mech.proposals[0]).toMatchObject({ block: 'a', state: 'open', after: 'S, for closed terms' });
    expect(r.mech.proposals[0].id).toMatch(/^p\d+$/);
  });
  it('writes nothing when the build cannot run', async () => {
    const f = fake([ok()], [{ started: false, code: null, output: 'spawn lake ENOENT', files: [] }]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/lake build could not run.*ENOENT/) });
    expect(r.mech).toEqual(emptyMechanization());
    expect(f.calls).toEqual(['run', 'build']);
  });
  it('writes nothing when Lake fails without a Lean error, whatever the files look like', async () => {
    const f = fake([ok()], [{ started: true, code: 1, output: 'error: lakefile.toml:3:0: unexpected character\n', files: B_PROVED }]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/lake build could not run.*lakefile/s) });
    expect(r.mech).toEqual(emptyMechanization());
    expect(f.calls).toEqual(['run', 'build']);
  });
  it('writes nothing when the run failed before producing anything', async () => {
    const f = fake([{ ok: false, report: null, cancelled: false, error: 'Not logged in' }], [built([])]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r).toMatchObject({ ok: false, error: 'Not logged in' });
    expect(f.calls).toEqual(['run', 'build']);
  });
  it('records a cancelled job, with statuses from what is on disk', async () => {
    const f = fake([{ ok: false, report: null, cancelled: true, error: 'Cancelled.' }], [built(STATED)]);
    const r = await performJob(deps(f.bridge), 'sync');
    expect(r.ok).toBe(false);
    expect(r.mech.lastJob?.outcome).toBe('cancelled');
    expect(r.mech.blocks.a.status).toBe('stated');
    expect(f.calls).toEqual(['run', 'build', 'write']);
  });
});

describe('a proof', () => {
  it('syncs first when something is out of date, then proves', async () => {
    const f = fake([ok(), ok({ outcome: 'done', summary: 'Proved B.' })], [built(STATED), built(B_PROVED)]);
    const phases: string[] = [];
    const r = await proveWithSync(deps(f.bridge, { onPhase: (k) => phases.push(k) }), 'b');
    expect(f.calls).toEqual(['run', 'build', 'write', 'run', 'build', 'write']);
    expect(phases).toEqual(['sync', 'prove']);
    expect(f.jobs[1].prompt).toMatch(/^Job: prove/);
    expect(f.jobs[1].prompt).toContain('PW/ThmB.lean');
    expect(f.jobs[1].prompt).toContain('PW.LemA');
    expect(r.mech.blocks.b).toMatchObject({ status: 'proved', assumes: ['a'] });
    expect(r.mech.lastJob).toMatchObject({ kind: 'prove', target: 'b', summary: 'Proved B.' });
  });
  it('goes straight to the proof when everything is up to date', async () => {
    const synced = (await performJob(deps(fake([ok()], [built(STATED)]).bridge), 'sync')).mech;
    const f = fake([ok()], [built(B_PROVED)]);
    await proveWithSync(deps(f.bridge, { mech: synced }), 'b');
    expect(f.calls).toEqual(['run', 'build', 'write']);
    expect(f.jobs[0].prompt).toMatch(/^Job: prove/);
  });
  it('is not attempted when the sync leaves the statement failed', async () => {
    const f = fake([ok()], [built(STATED, "error: ././././PW/Defs.lean:2:0: unknown identifier 'x'")]);
    const r = await proveWithSync(deps(f.bridge), 'b');
    expect(f.calls).toEqual(['run', 'build', 'write']);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not attempted/);
  });
  it('keeps a proof that failed as failed, with Lean’s error', async () => {
    const synced = (await performJob(deps(fake([ok()], [built(STATED)]).bridge), 'sync')).mech;
    const f = fake([ok({ outcome: 'failed', summary: 'Stuck in the base case.' })], [built(B_PROVED, 'error: ././././PW/ThmB.lean:5:2: unsolved goals')]);
    const r = await proveWithSync(deps(f.bridge, { mech: synced }), 'b');
    expect(r.mech.blocks.b.status).toBe('failed');
    expect(r.mech.blocks.b.findings[0]).toMatchObject({ kind: 'stuck', message: 'unsolved goals', lean: { file: 'PW/ThmB.lean', line: 5 } });
    expect(r.mech.blocks.a.status).toBe('stated');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lean-view.test.ts tests/lean-job.test.ts`
Expected: FAIL, cannot resolve `../src/lean/view` and `../src/lean/job`.

- [ ] **Step 3: Write the view**

`src/lean/view.ts`:

```ts
// The Lean tab's rows: each definition and statement with the status to show
// for it, worked out from the open document and the status file. "Not
// translated" and "out of date" are never stored; they are what comparing the
// two gives.

import type { Block, Doc, Id } from '../model/types';
import { docItems, staleness, type Item } from './items';
import { applies } from './proposals';
import type { Finding, Mechanization, StoredProposal } from './status';

export type RowStatus = 'none' | 'stale' | 'translated' | 'stated' | 'proved' | 'deviations' | 'failed';

export interface LeanProposal extends StoredProposal {
  /** Whether the field still reads as it did when the proposal was made. */
  applicable: boolean;
}

export interface LeanRow {
  id: Id;
  item: Item;
  status: RowStatus;
  /** Cited statements a finished proof still rests on. */
  assumes: Id[];
  /** The written proof was edited after it was mechanized. */
  proofChanged: boolean;
  canProve: boolean;
  file: string;
  findings: Finding[];
  proposals: LeanProposal[];
}

export interface LeanView {
  definitions: LeanRow[];
  statements: LeanRow[];
  byId: Map<Id, LeanRow>;
  /** How many rows are untranslated or out of date. */
  outOfDate: number;
  needsSync: boolean;
  /** Open proposals for blocks outside every definition and statement. */
  loose: LeanProposal[];
}

/** Each block's enclosing definition or statement; one of those owns itself. Blocks outside all of them are absent. */
export function owners(doc: Doc, itemIds: ReadonlySet<Id>): Map<Id, Id> {
  const out = new Map<Id, Id>();
  const walk = (blocks: Block[], owner: Id | null) => {
    for (const b of blocks) {
      const mine = itemIds.has(b.id) ? b.id : owner;
      if (mine) out.set(b.id, mine);
      if (b.type === 'theorem' && b.proof) walk(b.proof, mine);
      if (b.type === 'cases') for (const c of b.cases) walk(c.body, mine);
    }
  };
  walk(doc.blocks, null);
  return out;
}

function build(doc: Doc, mech: Mechanization): LeanView {
  const items = docItems(doc);
  const stale = staleness(items, mech.blocks);
  const own = owners(doc, new Set(items.map((i) => i.id)));
  const open: LeanProposal[] = mech.proposals.filter((p) => p.state === 'open').map((p) => ({ ...p, applicable: applies(doc, p) }));

  const rows = items.map((item): LeanRow => {
    const rec = mech.blocks[item.id];
    let status: RowStatus;
    if (!rec) status = 'none';
    else if (stale.stale.has(item.id) || (item.kind === 'statement' && stale.defsStale)) status = 'stale';
    else if (rec.status === 'proved' && rec.findings.some((f) => f.kind === 'deviation')) status = 'deviations';
    else status = rec.status;
    const proved = status === 'proved' || status === 'deviations';
    return {
      id: item.id, item, status,
      assumes: proved ? rec?.assumes ?? [] : [],
      proofChanged: proved && stale.proofChanged.has(item.id),
      canProve: item.kind === 'statement' && item.hasProof && item.theoremKind !== 'conjecture',
      file: rec?.file ?? '',
      findings: rec?.findings ?? [],
      proposals: open.filter((p) => own.get(p.block) === item.id),
    };
  });
  const outOfDate = rows.filter((r) => r.status === 'none' || r.status === 'stale').length;
  return {
    definitions: rows.filter((r) => r.item.kind !== 'statement'),
    statements: rows.filter((r) => r.item.kind === 'statement'),
    byId: new Map(rows.map((r) => [r.id, r])),
    outOfDate,
    needsSync: outOfDate > 0 || stale.deleted.length > 0,
    loose: open.filter((p) => !own.has(p.block)),
  };
}

let lastDoc: Doc | null = null;
let lastMech: Mechanization | null = null;
let last: LeanView | null = null;

/** The view for a document and its status file. Asked for by the tab and by every statement's dot, so the latest one is kept. */
export function leanView(doc: Doc, mech: Mechanization): LeanView {
  if (last && doc === lastDoc && mech === lastMech) return last;
  last = build(doc, mech);
  lastDoc = doc;
  lastMech = mech;
  return last;
}
```

- [ ] **Step 4: Write the job runner**

`src/lean/job.ts`:

```ts
// One job from start to finish, as the window sees it: tell Claude what to do,
// then build, then work out from the build what is now true and record it.
// The order matters: the build runs whatever the run reported, even after a
// cancel, because the Lean files are whatever they are by then.

import type { Doc, Id } from '../model/types';
import { walkBlocks } from '../export/context';
import { checkDoc } from '../check';
import { uid } from '../model/util';
import type { LeanBridge } from '../util/desktop';
import { parseBuild } from './build';
import { derive } from './derive';
import { docItems, staleness } from './items';
import { mergeProposals } from './proposals';
import { REPORT_SCHEMA, provePrompt, syncPrompt } from './prompt';
import { docMarkdown } from './snapshot';
import { readReport, type JobReport, type Mechanization } from './status';
import { leanView, owners } from './view';

export interface JobDeps {
  bridge: LeanBridge;
  doc: Doc;
  docPath: string;
  mech: Mechanization;
  /** '' leaves the choice to the user's Claude Code settings. */
  model: string;
  effort: string;
  now?: () => Date;
  newId?: () => string;
  /** Called as each job of a proof request starts: the sync, if one is needed, then the proof. */
  onPhase?: (kind: 'sync' | 'prove') => void;
}

export interface JobResult { mech: Mechanization; ok: boolean; error: string | null }

/** A statement's id to the ids of the statements and definitions its proof cites. */
function citesOf(doc: Doc): Map<Id, Id[]> {
  const report = checkDoc(doc);
  const byLabel = new Map<string, Id>();
  for (const s of report.statements) if (s.label && !byLabel.has(s.label)) byLabel.set(s.label, s.id);
  return new Map(report.statements.map((s) => [s.id, s.cites.map((l) => byLabel.get(l)).filter((x): x is Id => !!x && x !== s.id)]));
}

/** Findings are kept per definition or statement; one about a block inside a proof moves to the statement, remembering the block. */
function attach(report: JobReport, own: Map<Id, Id>): JobReport {
  const findings = report.findings.flatMap((f) => {
    const owner = own.get(f.block);
    if (!owner) return [];
    return [owner === f.block ? f : { ...f, block: owner, at: f.at ?? f.block }];
  });
  return { ...report, findings };
}

export async function performJob(d: JobDeps, kind: 'sync' | 'prove', target?: Id): Promise<JobResult> {
  const { bridge, doc, docPath, mech, model, effort } = d;
  const items = docItems(doc);
  const byId = new Map(items.map((i) => [i.id, i]));
  const cites = citesOf(doc);
  const item = target ? byId.get(target) : undefined;
  if (kind === 'prove' && !item) return { mech, ok: false, error: 'That statement is no longer in the document.' };

  d.onPhase?.(kind);
  const prompt = kind === 'sync'
    ? syncPrompt({ items, stale: staleness(items, mech.blocks), cites, first: Object.keys(mech.blocks).length === 0 })
    : provePrompt({ item: item!, cited: (cites.get(item!.id) ?? []).map((c) => byId.get(c)).filter((c) => c?.kind === 'statement').map((c) => c!) });
  const ran = await bridge.run({ docPath, prompt, snapshot: { json: JSON.stringify(doc, null, 2), md: docMarkdown(doc) }, schema: REPORT_SCHEMA, model, effort });

  const built = await bridge.build(docPath);
  if (!built.started) return { mech, ok: false, error: `lake build could not run: ${built.output}` };
  const diagnostics = parseBuild(built.output);
  // Lake failed without a single Lean error (a broken lakefile, a missing
  // toolchain, a build cut short): the files were not checked, so their
  // contents must not be read as statuses
  if (built.code !== 0 && !diagnostics.some((x) => x.severity === 'error')) {
    return { mech, ok: false, error: `lake build could not run: ${built.output.trim().split('\n').slice(-6).join('\n')}` };
  }

  const known = new Set<Id>();
  walkBlocks(doc.blocks, (b) => { known.add(b.id); });
  const read = readReport(ran.report, known);
  // nothing ran and nothing is there: recording every block as failed would say more than is known
  if (!ran.ok && !read && built.files.length === 0) return { mech, ok: false, error: ran.error ?? 'The job failed.' };
  const report = read && attach(read, owners(doc, new Set(byId.keys())));

  const blocks = derive({ items, cites, report, diagnostics, files: built.files, previous: mech.blocks, target: kind === 'prove' ? target : undefined });
  const next: Mechanization = {
    version: 1,
    blocks,
    proposals: mergeProposals(mech.proposals, read?.proposals ?? [], kind === 'prove' ? target! : null, d.newId ?? uid),
    lastJob: {
      kind,
      ...(kind === 'prove' ? { target } : {}),
      endedAt: (d.now?.() ?? new Date()).toISOString(),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      outcome: ran.cancelled ? 'cancelled' : read?.outcome ?? 'failed',
      summary: read?.summary || ran.error || '',
      changes: read?.changes ?? [],
    },
  };
  await bridge.writeStatus(docPath, next);
  return { mech: next, ok: ran.ok, error: ran.ok ? null : ran.error ?? 'The job failed.' };
}

/** A proof request: the definitions and statements are brought up to date first, and the proof is not attempted if that fails. */
export async function proveWithSync(d: JobDeps, target: Id): Promise<JobResult> {
  let mech = d.mech;
  if (leanView(d.doc, mech).needsSync) {
    const synced = await performJob(d, 'sync');
    mech = synced.mech;
    const status = mech.blocks[target]?.status;
    if (!synced.ok || !status || status === 'failed') {
      return { mech, ok: false, error: synced.error ?? 'The statement does not compile after the sync, so its proof was not attempted.' };
    }
  }
  return performJob({ ...d, mech }, 'prove', target);
}
```

Note for the "is not attempted" test: the sync there succeeds (`ok`) but leaves `b` failed, so the message is the fixed one, which contains "not attempted".

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/lean-view.test.ts tests/lean-job.test.ts && npx tsc --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Write the store**

`src/lean/store.ts`:

```ts
// The Lean state of the open document, for the tab and the dots on statements:
// what the status file holds, the job that is running, and the model and
// effort the next job will use. Kept apart from the document store because
// none of it is part of the document or its undo history.

import { create } from 'zustand';
import type { Doc, Id } from '../model/types';
import { useStore } from '../store';
import { desktop, type LeanTools } from '../util/desktop';
import { performJob, proveWithSync, type JobDeps, type JobResult } from './job';
import { EFFORTS, MODELS, type Effort, type Model } from './prompt';
import { applyProposal } from './proposals';
import { emptyMechanization, readMechanization, type Mechanization } from './status';

const PREFS_KEY = 'proof-writer:lean';
const MAX_LINES = 8;

interface Prefs { model: Model | ''; effort: Effort | '' }

function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    return {
      model: (MODELS as readonly string[]).includes(v.model ?? '') ? (v.model as Model) : '',
      effort: (EFFORTS as readonly string[]).includes(v.effort ?? '') ? (v.effort as Effort) : '',
    };
  } catch {
    return { model: '', effort: '' };
  }
}
/** Losing this is harmless, so a failure is not reported. */
function keepPrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export interface RunningJob { kind: 'sync' | 'prove'; target?: Id; lines: string[]; model: string; effort: string }

interface LeanState extends Prefs {
  /** The file of the open document; null when it has none. */
  docPath: string | null;
  tools: LeanTools | null;
  dir: string | null;
  mech: Mechanization;
  job: RunningJob | null;
  error: string | null;
  /** The row the tab was last asked to show; `n` makes each request distinct. */
  focus: { id: Id; n: number } | null;

  load: (docPath: string | null) => Promise<void>;
  checkTools: () => Promise<void>;
  sync: () => Promise<void>;
  prove: (id: Id) => Promise<void>;
  cancel: () => void;
  /** Accepts or dismisses a proposal. Accepting edits the document as one undo step. */
  settle: (proposalId: string, accept: boolean) => Promise<void>;
  recreate: () => Promise<void>;
  reveal: () => void;
  setModel: (m: Model | '') => void;
  setEffort: (e: Effort | '') => void;
  show: (id: Id) => void;
}

/** An error from the main process without Electron's wrapping. */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let listening = false;
function listen() {
  if (listening || !desktop) return;
  listening = true;
  desktop.lean.onEvent(({ line }) => {
    useLean.setState((s) => (s.job ? { job: { ...s.job, lines: [...s.job.lines, line].slice(-MAX_LINES) } } : {}));
  });
}

async function start(kind: 'sync' | 'prove', target?: Id) {
  const s = useLean.getState();
  if (!desktop || !s.docPath || s.job) return;
  const docPath = s.docPath;
  const { model, effort } = s;
  useLean.setState({ job: { kind, target, lines: [], model, effort }, error: null });
  try {
    const deps: JobDeps = {
      bridge: desktop.lean, doc: useStore.getState().doc, docPath, mech: s.mech, model, effort,
      onPhase: (k) => useLean.setState((st) => (st.job ? { job: { ...st.job, kind: k, lines: [] } } : {})),
    };
    const r: JobResult = kind === 'sync' ? await performJob(deps, 'sync') : await proveWithSync(deps, target!);
    // the user may have opened another document meanwhile; this result is not about it
    if (useLean.getState().docPath === docPath) useLean.setState({ mech: r.mech, error: r.error });
  } catch (e) {
    useLean.setState({ error: message(e) });
  } finally {
    useLean.setState({ job: null });
  }
}

export const useLean = create<LeanState>((set, get) => ({
  ...readPrefs(),
  docPath: null,
  tools: null,
  dir: null,
  mech: emptyMechanization(),
  job: null,
  error: null,
  focus: null,

  load: async (docPath) => {
    set({ docPath, dir: null, mech: emptyMechanization(), error: null });
    if (!desktop) return;
    listen();
    try {
      const tools = await desktop.lean.tools();
      if (!docPath) { set({ tools }); return; }
      // the main process serves only the document this window is watching
      await desktop.watchDocument(docPath);
      const { dir, status } = await desktop.lean.open(docPath);
      if (get().docPath === docPath) set({ tools, dir, mech: readMechanization(status) });
    } catch (e) {
      set({ error: message(e) });
    }
  },
  checkTools: async () => {
    if (desktop) set({ tools: await desktop.lean.tools() });
  },
  sync: () => start('sync'),
  prove: (id) => start('prove', id),
  cancel: () => { void desktop?.lean.cancel(); },
  settle: async (proposalId, accept) => {
    const { mech, docPath } = get();
    const p = mech.proposals.find((x) => x.id === proposalId);
    if (!p || p.state !== 'open') return;
    if (accept) {
      let applied = false;
      useStore.getState().update((d) => { applied = applyProposal(d as Doc, p); });
      if (!applied) return;
    }
    const next: Mechanization = { ...mech, proposals: mech.proposals.map((x) => (x.id === proposalId ? { ...x, state: accept ? 'accepted' as const : 'dismissed' as const } : x)) };
    set({ mech: next });
    if (desktop && docPath) {
      try { await desktop.lean.writeStatus(docPath, next); } catch (e) { set({ error: message(e) }); }
    }
  },
  recreate: async () => {
    const { docPath } = get();
    if (!desktop || !docPath) return;
    try { await desktop.lean.recreate(docPath); set({ error: null }); } catch (e) { set({ error: message(e) }); }
  },
  reveal: () => {
    const { docPath } = get();
    if (desktop && docPath) void desktop.lean.reveal(docPath).catch(() => {});
  },
  setModel: (model) => { set({ model }); keepPrefs({ model, effort: get().effort }); },
  setEffort: (effort) => { set({ effort }); keepPrefs({ model: get().model, effort }); },
  show: (id) => {
    useStore.getState().showView('sidebar');
    set({ focus: { id, n: (get().focus?.n ?? 0) + 1 } });
  },
}));
```

- [ ] **Step 7: Verify**

Run: `npx tsc --noEmit && npx vitest run`
Expected: no type errors, all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lean/view.ts src/lean/job.ts src/lean/store.ts tests/lean-view.test.ts tests/lean-job.test.ts
git commit -m "Run a mechanization job from the window and work out what to show"
```

---

### Task 10: The Lean tab and the status dot on statements

**Files:**
- Create: `src/components/Lean.tsx`
- Modify: `src/components/Sidebar.tsx:14-37` (the `Sidebar` component)
- Modify: `src/components/Blocks.tsx` (imports; `TheoremEditor`'s `thm-head`)
- Modify: `src/App.tsx:32` (first line of `App`)
- Modify: `src/styles.css` (after the `.tk-where` rule, near line 423)

**Interfaces:**
- Consumes: `useLean`, `RunningJob` (Task 9); `leanView`, `LeanRow`, `LeanProposal`, `RowStatus` (Task 9); `MODELS`, `EFFORTS` (Task 6); `desktop`; `jumpToBlock` from `src/components/Tracker.tsx`; `useNumbering` from `src/components/ProseView.tsx`.
- Produces: `Lean` (the tab), `LeanDot({ id })` (the dot on a statement), `useLeanDocument()` (keeps the Lean state on the open document), `useLeanView()`.

The codebase has no component tests; this task is verified by the type check, the build and the manual run in Step 7.

- [ ] **Step 1: Write the tab**

`src/components/Lean.tsx`:

```tsx
import { useDeferredValue, useEffect } from 'react';
import { useStore } from '../store';
import { useLean, type RunningJob } from '../lean/store';
import { leanView, type LeanProposal, type LeanRow, type LeanView, type RowStatus } from '../lean/view';
import { EFFORTS, MODELS, type Effort, type Model } from '../lean/prompt';
import type { Finding } from '../lean/status';
import { desktop } from '../util/desktop';
import { jumpToBlock } from './Tracker';
import { useNumbering } from './ProseView';

const STATUS: Record<RowStatus, string> = {
  none: 'Not translated',
  stale: 'Out of date',
  translated: 'Translated',
  stated: 'Stated, not proved',
  proved: 'Proved',
  deviations: 'Proved with deviations',
  failed: 'Failed',
};
const FINDING: Record<Finding['kind'], string> = { deviation: 'Deviation', inconsistency: 'Inconsistency', stuck: 'Stuck' };
const MODEL_NAME: Record<Model, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const EFFORT_NAME: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** Keeps the Lean state on the file of the open document. Called once, by the app. */
export function useLeanDocument() {
  const file = useStore((s) => s.index.find((m) => m.id === s.docId)?.file ?? null);
  useEffect(() => { void useLean.getState().load(file); }, [file]);
}

/** The Lean rows for the open document, a beat behind typing. */
export function useLeanView(): LeanView {
  const doc = useDeferredValue(useStore((s) => s.doc));
  const mech = useLean((s) => s.mech);
  return leanView(doc, mech);
}

/** What to call a row: "Lemma 2 (Canonical forms)", "Rules: Typing". */
function useRowName() {
  const num = useNumbering();
  return (row: LeanRow) => {
    const { item } = row;
    if (item.kind === 'grammar') return `Grammar${item.title ? `: ${item.title}` : ''}`;
    if (item.kind === 'rules') return `Rules${item.title ? `: ${item.title}` : ''}`;
    return `${num.byId.get(row.id) ?? 'Statement'}${item.title ? ` (${item.title})` : ''}`;
  };
}

export function Lean() {
  const { tools, docPath, dir, job, error, mech, focus } = useLean();
  const view = useLeanView();
  const name = useRowName();

  useEffect(() => {
    if (focus) document.getElementById('lean-row-' + focus.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focus]);

  if (!desktop) return null;
  if (!docPath) return <p className="dim">Save the document to a file to mechanize it. Its Lean files are kept in a folder beside it.</p>;
  if (!tools) return <p className="dim">Looking for Claude Code and Lean…</p>;
  if (!tools.claude || !tools.lake) return <Setup claude={!!tools.claude} lake={!!tools.lake} />;

  const busy = job !== null;
  const { sync, prove, cancel, reveal, recreate } = useLean.getState();
  return (
    <div className="lean">
      <div className="lean-bar">
        <button className="primary" disabled={busy || !view.needsSync} onClick={() => void sync()} title="Translate the definitions and state every lemma and theorem in Lean">
          Sync definitions{view.outOfDate > 0 && <span className="tab-count">{view.outOfDate}</span>}
        </button>
        <Choices disabled={busy} />
      </div>
      {job && <Running job={job} name={job.target ? name(view.byId.get(job.target) ?? ({ id: job.target, item: { kind: 'statement', title: '' } } as LeanRow)) : ''} onCancel={cancel} />}
      {error && (
        <div className="lean-error">
          <p>{error}</p>
          {/lake build could not run/.test(error) && <button className="mini" disabled={busy} onClick={() => void recreate()}>Recreate project files</button>}
        </div>
      )}
      {view.definitions.length > 0 && <h4>Definitions</h4>}
      {view.definitions.map((r) => <Row key={r.id} row={r} name={name} busy={busy} />)}
      {view.statements.length > 0 && <h4>Statements</h4>}
      {view.statements.map((r) => <Row key={r.id} row={r} name={name} busy={busy} onProve={() => void prove(r.id)} />)}
      {view.definitions.length + view.statements.length === 0 && <p className="dim">No grammars, rules, definitions or statements yet.</p>}
      {view.loose.length > 0 && <h4>Other proposed edits</h4>}
      {view.loose.map((p) => <ProposalView key={p.id} p={p} busy={busy} />)}
      {mech.lastJob && <LastJob />}
      {dir && <p className="lean-dir dim">Lean files: <a onClick={reveal} title={dir}>{dir.split(/[\\/]/).pop()}</a></p>}
    </div>
  );
}

function Setup({ claude, lake }: { claude: boolean; lake: boolean }) {
  const windows = desktop?.platform === 'win32';
  return (
    <div className="lean-setup">
      <p>Mechanizing a document needs two programs on this computer.</p>
      {!claude && (
        <p><strong>Claude Code</strong> was not found. Install it from <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">claude.com/claude-code</a> and sign in by running <code>claude</code> once in a terminal.</p>
      )}
      {!lake && (
        <p>
          <strong>Lean</strong> was not found. {windows
            ? <>Install it with the elan installer from <a href="https://lean-lang.org/install/" target="_blank" rel="noreferrer">lean-lang.org/install</a>.</>
            : <>Install it by running this in a terminal:<code className="lean-cmd">curl https://elan.lean-lang.org/elan-init.sh -sSf | sh</code></>}
        </p>
      )}
      <button onClick={() => void useLean.getState().checkTools()}>Check again</button>
    </div>
  );
}

function Choices({ disabled }: { disabled: boolean }) {
  const model = useLean((s) => s.model);
  const effort = useLean((s) => s.effort);
  const { setModel, setEffort } = useLean.getState();
  return (
    <span className="lean-choices">
      <select value={model} disabled={disabled} onChange={(e) => setModel(e.target.value as Model | '')} title="The model the next job runs with. Default leaves it to your Claude Code settings." aria-label="Model">
        <option value="">Default model</option>
        {MODELS.map((m) => <option key={m} value={m}>{MODEL_NAME[m]}</option>)}
      </select>
      <select value={effort} disabled={disabled} onChange={(e) => setEffort(e.target.value as Effort | '')} title="How hard the next job thinks. Default leaves it to your Claude Code settings." aria-label="Effort">
        <option value="">Default effort</option>
        {EFFORTS.map((x) => <option key={x} value={x}>{EFFORT_NAME[x]}</option>)}
      </select>
    </span>
  );
}

function Running({ job, name, onCancel }: { job: RunningJob; name: string; onCancel: () => void }) {
  const what = job.kind === 'sync' ? 'Syncing definitions' : `Proving ${name}`;
  const settings = [job.model && MODEL_NAME[job.model as Model], job.effort && EFFORT_NAME[job.effort as Effort].toLowerCase()].filter(Boolean).join(', ');
  return (
    <div className="lean-job" role="status">
      <div className="lean-job-head">
        <strong>{what}{settings && ` · ${settings}`}</strong>
        <button className="mini danger" onClick={onCancel}>Cancel</button>
      </div>
      {job.lines.length ? <ul>{job.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : <p className="dim">Starting…</p>}
    </div>
  );
}

function Row({ row, name, busy, onProve }: { row: LeanRow; name: (r: LeanRow) => string; busy: boolean; onProve?: () => void }) {
  const view = useLeanView();
  const attempted = row.status === 'proved' || row.status === 'deviations' || row.status === 'failed';
  const assumes = row.assumes.map((id) => { const r = view.byId.get(id); return r ? name(r) : id; });
  return (
    <section className="tk-group lean-row" id={'lean-row-' + row.id}>
      <div className="lean-row-head">
        <a className="tk-head" onClick={() => jumpToBlock(row.id)} title="Go to this block">
          <span className={'tk-dot lean-' + row.status} />
          <span className="tk-name">{name(row)}</span>
        </a>
        {onProve && row.canProve && <button className="mini" disabled={busy} onClick={onProve}>{attempted ? 'Prove again' : 'Prove'}</button>}
      </div>
      <div className="tk-line dim">
        {STATUS[row.status]}{assumes.length > 0 && `, assuming ${assumes.join(', ')}`}{row.file && ` · ${row.file}`}
      </div>
      {row.proofChanged && <div className="tk-line dim">The written proof has changed since.</div>}
      {row.findings.length > 0 && (
        <ul className="tk-issues">
          {row.findings.map((f, i) => (
            <li key={i} className={f.kind === 'deviation' ? 'info' : f.kind === 'inconsistency' ? 'warning' : 'error'}>
              <a onClick={() => jumpToBlock(row.id)}>
                <span className="tk-where">{FINDING[f.kind]}</span> {f.message}
                {f.lean && <span className="dim"> ({f.lean.file}:{f.lean.line})</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
      {row.proposals.map((p) => <ProposalView key={p.id} p={p} busy={busy} />)}
    </section>
  );
}

function ProposalView({ p, busy }: { p: LeanProposal; busy: boolean }) {
  const { settle } = useLean.getState();
  return (
    <div className="lean-proposal">
      <div className="lean-proposal-head">Proposed edit{p.why && <span className="dim">: {p.why}</span>}</div>
      {p.before && <pre className="lean-before">{p.before}</pre>}
      {p.after ? <pre className="lean-after">{p.after}</pre> : <div className="dim">(remove it)</div>}
      <div className="row">
        <button className="mini primary" disabled={busy || !p.applicable} onClick={() => void settle(p.id, true)} title={p.applicable ? 'Make this edit in the document' : 'The text has changed since this was proposed'}>Accept</button>
        <button className="mini" onClick={() => void settle(p.id, false)}>Dismiss</button>
        <a className="dim" onClick={() => jumpToBlock(p.block)}>show</a>
        {!p.applicable && <span className="dim">no longer applies</span>}
      </div>
    </div>
  );
}

function LastJob() {
  const job = useLean((s) => s.mech.lastJob)!;
  const what = job.kind === 'sync' ? 'Last sync' : 'Last proof';
  return (
    <details className="lean-last">
      <summary>{what}: {job.outcome}, {new Date(job.endedAt).toLocaleString()}</summary>
      {job.summary && <p>{job.summary}</p>}
      {job.changes.length > 0 ? (
        <ul>{job.changes.map((c, i) => <li key={i}><span className={'lean-change ' + c.change}>{c.change}</span> <code>{c.name}</code> <span className="dim">{c.file}</span></li>)}</ul>
      ) : <p className="dim">No Lean declarations were reported as changed.</p>}
    </details>
  );
}

/** The status dot on a statement in the editor; clicking it opens the Lean tab at that statement. */
export function LeanDot({ id }: { id: string }) {
  const hasFile = useLean((s) => s.docPath !== null);
  const row = useLeanView().byId.get(id);
  if (!desktop || !hasFile || !row || row.status === 'none') return null;
  return <button className={'lean-dot tk-dot lean-' + row.status} title={`Lean: ${STATUS[row.status]}`} aria-label={`Lean: ${STATUS[row.status]}`} onClick={() => useLean.getState().show(id)} />;
}
```

- [ ] **Step 2: Add the tab to the sidebar**

In `src/components/Sidebar.tsx`, add to the imports:

```tsx
import { useEffect } from 'react';
import { Lean, useLeanView } from './Lean';
import { useLean } from '../lean/store';
```

(merge `useEffect` into the existing `import { useState } from 'react';` line as `import { useEffect, useState } from 'react';`).

Replace the body of `Sidebar` up to and including its `return (...)` with:

```tsx
export function Sidebar() {
  const [tab, setTab] = useState<'outline' | 'snippets' | 'docs' | 'tracker' | 'lean'>('snippets');
  const tracker = useTracker();
  const problems = tracker.errors + tracker.warnings;
  const lean = useLeanView();
  const leanFailed = lean.statements.concat(lean.definitions).filter((r) => r.status === 'failed').length;
  // a statement's dot in the editor asks for its row here
  const focus = useLean((s) => s.focus);
  useEffect(() => { if (focus) setTab('lean'); }, [focus]);
  return (
    <aside className="sidebar">
      <div className="tabs">
        <button className={tab === 'snippets' ? 'active' : ''} onClick={() => setTab('snippets')}>Snippets</button>
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}>Outline</button>
        <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>{desktop ? 'Files' : 'Documents'}</button>
        <button className={tab === 'tracker' ? 'active' : ''} onClick={() => setTab('tracker')} title="Missing cases, broken references and unfinished proofs">
          Tracker{problems > 0 && <span className={'tab-count' + (tracker.errors ? ' error' : '')}>{problems}</span>}
        </button>
        {desktop && (
          <button className={tab === 'lean' ? 'active' : ''} onClick={() => setTab('lean')} title="Mechanize the definitions and proofs in Lean with Claude Code">
            Lean{leanFailed > 0 && <span className="tab-count error">{leanFailed}</span>}
          </button>
        )}
      </div>
      <div className="sidebar-body">
        {tab === 'outline' && <Outline />}
        {tab === 'snippets' && <Snippets />}
        {tab === 'docs' && desktop && <Files />}
        {tab === 'docs' && desktop && <h4 className="files-open">Open documents</h4>}
        {tab === 'docs' && <Docs />}
        {tab === 'tracker' && <Tracker view={tracker} />}
        {tab === 'lean' && <Lean />}
      </div>
    </aside>
  );
}
```

- [ ] **Step 3: Add the dot to statements and load the Lean state**

In `src/components/Blocks.tsx`, add to the imports:

```tsx
import { LeanDot } from './Lean';
```

and in `TheoremEditor`, directly after the line `<strong className="thm-num">{num.byId.get(b.id)}</strong>`, add:

```tsx
        {b.kind !== 'definition' && <LeanDot id={b.id} />}
```

In `src/App.tsx`, add to the imports:

```tsx
import { useLeanDocument } from './components/Lean';
```

and make it the first statement of `App`:

```tsx
export default function App() {
  useLeanDocument();
```

- [ ] **Step 4: Style it**

In `src/styles.css`, after the `.tk-where { font-weight: 600; }` rule, add:

```css
/* The Lean tab. Rows reuse the Tracker's group, dot and issue styles. */
.lean h4 { margin: 14px 0 4px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim); }
.lean-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 4px 0 8px; }
.lean-choices { display: flex; gap: 4px; }
.lean-choices select { font-size: 12px; padding: 2px 2px; min-width: 0; max-width: 120px; }
.lean-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.lean-row-head .tk-head { flex: 1; min-width: 0; }
.tk-dot.lean-none { background: var(--line-strong); }
.tk-dot.lean-stale { background: var(--warn); }
.tk-dot.lean-stated { background: var(--accent); }
.tk-dot.lean-translated, .tk-dot.lean-proved { background: var(--ok); }
.tk-dot.lean-deviations { background: var(--ok); box-shadow: 0 0 0 2px var(--warn); }
.tk-dot.lean-failed { background: var(--danger); }
button.lean-dot { display: inline-block; padding: 0; border: none; cursor: pointer; margin: 0 2px; }
.lean-job { margin: 6px 0 10px; padding: 6px 8px; border: 1px solid var(--accent-line); border-radius: 6px; background: var(--accent-glow); font-size: 13px; }
.lean-job-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.lean-job ul { list-style: none; margin: 4px 0 0; padding: 0; font-family: var(--mono, monospace); font-size: 12px; color: var(--dim); }
.lean-job li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lean-error { margin: 6px 0 10px; padding: 6px 8px; border: 1px solid var(--danger-line); border-radius: 6px; background: var(--danger-bg); color: var(--danger); font-size: 13px; }
.lean-error p { margin: 0 0 4px; white-space: pre-wrap; }
.lean-proposal { margin: 4px 0 6px 15px; padding: 6px 8px; border-left: 2px solid var(--accent); background: var(--accent-glow); border-radius: 0 5px 5px 0; font-size: 13px; }
.lean-proposal-head { font-weight: 600; margin-bottom: 4px; }
.lean-proposal-head .dim { font-weight: 400; }
.lean-proposal pre { margin: 2px 0; padding: 3px 6px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.lean-before { background: var(--danger-bg); text-decoration: line-through; }
.lean-after { background: var(--ok-bg); }
.lean-proposal .row { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
.lean-proposal a { cursor: pointer; }
.lean-last { margin-top: 14px; font-size: 13px; }
.lean-last summary { cursor: pointer; color: var(--dim); }
.lean-last ul { list-style: none; margin: 4px 0; padding: 0; }
.lean-change { font-size: 11px; padding: 0 4px; border-radius: 4px; background: var(--accent-soft); }
.lean-change.removed { background: var(--danger-bg); color: var(--danger); }
.lean-change.added { background: var(--ok-bg); color: var(--ok); }
.lean-dir { margin-top: 10px; font-size: 12px; }
.lean-dir a { cursor: pointer; text-decoration: underline; }
.lean-setup p { margin: 0 0 8px; }
.lean-cmd { display: block; margin-top: 4px; padding: 4px 6px; border-radius: 4px; background: var(--accent-soft); font-size: 12px; word-break: break-all; user-select: all; }
```

Check that the variables used exist: run `grep -n -- "--line-strong\|--mono" src/styles.css | head`. `--line-strong` is used by `.tk-issues a` already. If `--mono` is not defined, the fallback `monospace` applies; leave it.

- [ ] **Step 5: Verify types, tests and build**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: no type errors, all tests PASS, the build completes.

- [ ] **Step 6: Check the browser build is unchanged**

Run: `npm run dev`, open http://localhost:5173.
Expected: four sidebar tabs (no Lean tab), no dot beside any statement number, no console errors. Stop the dev server.

- [ ] **Step 7: Run it in the desktop app**

Run: `npm run electron:dev`. Then, with Lean **not** installed (as on the development machine today):

1. Open the Lean tab on the starting document (not in a file). Expected: "Save the document to a file to mechanize it."
2. File → Save As, into an empty folder as `stlc.proof.json`. Expected: the tab shows the setup panel saying Lean was not found, with the elan command, and nothing about Claude Code (it is installed).
3. Press **Check again**. Expected: no change, no error.

If Lean is installed (`lake --version` works in a terminal), continue:

4. Expected instead of the setup panel: **Sync definitions** with a count, the two selectors, and a row per definition and statement, all "Not translated".
5. Choose Haiku and Low, quit and relaunch. Expected: the selectors still read Haiku and Low.
6. Press **Sync definitions**. Expected: the job box appears reading "Syncing definitions · Haiku, low" with activity lines; the selectors and Prove buttons are disabled; **Cancel** is there. When it ends, rows read Translated or Stated (or Failed with a reason), and `stlc-lean/` beside the document holds `lakefile.toml`, `PW/Defs.lean`, `CLAUDE.md`, `CONVENTIONS.md` and `mechanization.json`.
7. Click the dot beside a lemma's number in the editor. Expected: the sidebar switches to the Lean tab and scrolls to that lemma.
8. Edit that lemma's statement. Expected: its row and dot turn "Out of date"; the others do not.
9. Edit a rule's conclusion. Expected: every statement turns "Out of date".
10. Start a sync and press **Cancel**. Expected: the job box goes away within a few seconds and "Last sync" reads cancelled.

Record which of 4 to 10 could not be run, and say so when reporting the task done.

- [ ] **Step 8: Commit**

```bash
git add src/components/Lean.tsx src/components/Sidebar.tsx src/components/Blocks.tsx src/App.tsx src/styles.css
git commit -m "Add the Lean tab and a mechanization status dot on statements"
```

---

### Task 11: Documentation and the end-to-end pass

**Files:**
- Modify: `docs/guide.md` (new section before `## Files in the desktop app`)
- Modify: `README.md` (one bullet under "What it does"; entries under "Source layout")

**Interfaces:**
- Consumes: the finished feature.
- Produces: user documentation.

- [ ] **Step 1: Write the guide section**

In `docs/guide.md`, directly before the line `## Files in the desktop app`, insert:

```markdown
## Mechanizing in Lean

In the desktop app, the **Lean** tab has [Claude Code](https://claude.com/claude-code)
turn the document into a [Lean 4](https://lean-lang.org) development and prove
its statements there. It needs both programs installed; if one is missing the
tab says which and how to get it. The document has to be saved to a file.

**Sync definitions** translates every grammar, rules block and definition, and
writes the Lean statement of every lemma and theorem with its proof left open.
**Prove**, beside a statement that has a written proof, asks for a Lean proof
that follows it: the same induction, the same cases, the same lemmas. A proof
may use a lemma that is not proved yet; it is then shown as proved *assuming*
that lemma.

Nothing runs until you press a button. Editing a block marks it **out of
date**, and editing a definition marks every statement out of date, until the
next sync; a proof request syncs first if anything is.

| Status | Meaning |
| --- | --- |
| Not translated | No Lean counterpart yet |
| Out of date | Changed since it was translated |
| Translated | A definition that compiles |
| Stated | The Lean statement compiles; no proof yet |
| Proved | Builds with nothing assumed |
| Proved with deviations | Builds, but the Lean statement differs from the text; the difference is listed |
| Failed | Did not compile; the reason is listed |

The app decides these itself by building the project and reading the files. A
statement is never shown as proved because Claude said so.

Under each row the tab lists what the last job found:

* a **deviation**: where the Lean text had to differ from yours, such as a
  hypothesis you left implicit;
* an **inconsistency**: two blocks that disagree, such as a proof case that
  uses a lemma in a way its statement does not allow;
* **stuck**: where a proof stopped, with Lean's error;
* a **proposed edit** to one field of the document, shown before and after.
  **Accept** makes the edit (undo takes it back); **Dismiss** hides it for
  good. A proposal for text you have since changed can no longer be accepted.

Claude never edits the document. It only writes Lean files.

The **Model** and **Effort** selectors choose what the next job runs with;
*Default* uses your Claude Code settings. The choice is remembered.

### The Lean folder

For `stlc.proof.json` the Lean files are in `stlc-lean/` beside it, an
ordinary Lake project with no dependencies that you can open in an editor:

* `PW/Defs.lean` holds the definitions, and `PW/<Label>.lean` one statement
  each. A comment `-- pw: <id>` above a declaration ties it to a block.
* `CLAUDE.md` holds the instructions Claude follows. The app rewrites it
  before every job.
* `CONVENTIONS.md` is yours: write there how you want things represented
  ("contexts are lists, newest binding first") and it is followed where it does
  not conflict with the rules in `CLAUDE.md`.
* `mechanization.json` is the app's record of statuses and findings.

Commit the folder with the document if you want the mechanization kept;
`.lake/` inside it is build output and is ignored. If you rename or move the
document, rename or move the folder with it, or the next sync starts afresh.

### Limits

Jobs run one at a time and stop after 30 minutes. Proofs use core Lean only,
so facts a library would provide (about finite maps, say) have to be proved
or avoided. A proof Claude cannot finish is reported, not papered over, and
that is often a sign the written proof has a gap.
```

- [ ] **Step 2: Update the README**

In `README.md`, under "What it does", after the bullet that begins `* **Checks on the proof's structure.**`, add:

```markdown
* **Mechanization in Lean.** In the desktop app, Claude Code translates the
  definitions into Lean 4 and proves lemmas on request, following the written
  proof. The app builds the result itself, and reports where the Lean text had
  to deviate from yours and which blocks disagree.
```

Under "Source layout", after the `src/check` entry, add:

```markdown
* `src/lean` — mechanization: what is out of date, the job prompts, reading a
  build into statuses, proposed edits, and the Lean tab's state
```

and change the `electron` entry's parenthetical list to end with:

```markdown
  the `window.desktop` bridge (`preload.cjs`), and running Claude Code and Lake
  for a document's Lean folder (`lean.cjs`, with the agent's instructions in
  `lean-instructions.md`)
```

- [ ] **Step 3: Full verification**

Run: `npx tsc --noEmit && npx vitest run && npm run build`
Expected: no type errors, all tests PASS, the build completes.

- [ ] **Step 4: End-to-end on the sample document**

This needs Lean installed. If it is not, stop here and report that this step was not run; do not describe the feature as verified end to end.

Run `npm run electron:dev`, then:

1. New document from "＋ STLC example"; save it as `stlc.proof.json` in an empty folder.
2. Lean tab → **Sync definitions** (Default model and effort). Expected: definitions Translated, statements Stated. Open `stlc-lean/PW/Defs.lean` and check every declaration has a `-- pw:` marker and the rules' constructors carry rule ids.
3. Run `cd stlc-lean && lake build` in a terminal. Expected: it builds; warnings about `sorry` only.
4. **Prove** the first lemma that has a written proof. Expected: Proved (possibly "assuming …" or "with deviations"), and its file has no `sorry`.
5. In the editor, delete a premise from a typing rule that lemma's proof relies on. Expected: every statement is Out of date.
6. **Prove** the same lemma again. Expected: a sync runs first; the lemma ends Failed or Stated with a Stuck finding or an Inconsistency naming the rule, and ideally a proposal restoring the premise.
7. **Accept** the proposal if there is one (or undo the deletion). Expected: the rule is back; Ctrl/Cmd+Z undoes the accepted edit as one step.
8. Close the window mid-job (start a sync, close). Relaunch. Expected: no job running, no crash, blocks still out of date.

Note anything that did not match and fix it before the final commit. Problems in what Claude writes (missing markers, statements that drift from the text) are fixed in `electron/lean-instructions.md`, not by loosening the app's checks.

- [ ] **Step 5: Commit**

```bash
git add docs/guide.md README.md
git commit -m "Document mechanizing a document in Lean"
```
