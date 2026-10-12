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
