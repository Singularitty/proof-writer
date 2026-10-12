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

/** A proof as its content: ids, folding and derivation captions left out. */
const proofContent = (proof: Block[] | undefined): unknown =>
  JSON.parse(JSON.stringify(proof ?? [], (k, v) => (k === 'id' || k === 'collapsed' || k === 'caption' ? undefined : v)));

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
  // Taken names are compared lower-cased: macOS's default filesystem ignores case.
  const taken = new Set<string>(['defs']);
  for (const s of statements) {
    let name = camel(s.label);
    if (!name) name = 'S' + camel(s.id);
    if (!/^[A-Z]/.test(name)) name = 'S' + name;
    if (taken.has(name.toLowerCase())) name = `${name}_${camel(s.id) || out.size}`;
    while (taken.has(name.toLowerCase())) name += '_';
    taken.add(name.toLowerCase());
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
        proofHash: hashOf(proofContent(b.proof), doc.snippets),
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
    if (r.hash !== i.hash || r.kind !== i.kind) {
      out.stale.add(i.id);
      if (i.kind !== 'statement' || r.kind !== 'statement') out.defsStale = true;
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
