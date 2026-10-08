import { Fragment, memo, useMemo } from 'react';
import { useStore } from '../store';
import { parseProse, expandTextSnippets, type Inline } from '../export/prose';
import { sanitizeLabel, walkBlocks } from '../export/context';
import { THEOREM_LABEL, type Doc } from '../model/types';
import { Math } from './Math';

let numCacheDoc: Doc | null = null;
let numCache: { labels: Map<string, string>; rules: Set<string>; byId: Map<string, string> } = {
  labels: new Map(), rules: new Set(), byId: new Map(),
};

/** "Lemma 3" etc. for each theorem label, plus the set of rule names. */
export function numbering(doc: Doc) {
  if (doc === numCacheDoc) return numCache;
  const labels = new Map<string, string>();
  const byId = new Map<string, string>();
  const rules = new Set<string>();
  const counters = new Map<string, number>();
  const shared = doc.settings.numberTheorems === 'shared';
  walkBlocks(doc.blocks, (b) => {
    if (b.type === 'theorem') {
      const key = shared ? 'thm' : b.kind;
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      const name = `${THEOREM_LABEL[b.kind]} ${n}`;
      byId.set(b.id, name);
      if (b.label) labels.set(sanitizeLabel(b.label), name);
    }
    if (b.type === 'rules') for (const r of b.rules) if (r.name) rules.add(r.name);
  });
  numCacheDoc = doc;
  numCache = { labels, rules, byId };
  return numCache;
}

export function useNumbering() {
  const doc = useStore((s) => s.doc);
  return numbering(doc);
}

function textSnippetMap(doc: Doc) {
  return new Map(doc.snippets.filter((s) => s.kind === 'text').map((s) => [s.name, s.body]));
}

function Inl({ xs }: { xs: Inline[] }) {
  const num = useNumbering();
  return (
    <>
      {xs.map((x, i) => {
        switch (x.k) {
          case 'text': return <Fragment key={i}>{x.v}</Fragment>;
          case 'math': return <Math key={i} tex={x.v} />;
          case 'b': return <strong key={i}><Inl xs={x.c} /></strong>;
          case 'i': return <em key={i}><Inl xs={x.c} /></em>;
          case 'code': return <code key={i}>{x.v}</code>;
          case 'ref': {
            const l = num.labels.get(sanitizeLabel(x.v));
            if (l) return <span key={i} className="ref" title={x.v}>{l}</span>;
            if (num.rules.has(x.v)) return <span key={i} className="rulename">{x.v}</span>;
            return <span key={i} className="ref bad" title="Unknown reference">[[{x.v}]]</span>;
          }
        }
      })}
    </>
  );
}

export const ProseView = memo(function ProseView({ text, inline }: { text: string; inline?: boolean }) {
  const doc = useStore((s) => s.doc);
  const snippets = doc.snippets;
  const blocks = useMemo(() => parseProse(expandTextSnippets(text, textSnippetMap(doc))), [text, snippets]); // eslint-disable-line
  if (inline) {
    return <>{blocks.map((b, i) => (b.k === 'p' ? <Inl key={i} xs={b.c} /> : null))}</>;
  }
  return (
    <div className="prose">
      {blocks.map((b, i) => {
        switch (b.k) {
          case 'p': return <p key={i}><Inl xs={b.c} /></p>;
          case 'ul': return <ul key={i}>{b.items.map((it, j) => <li key={j}><Inl xs={it} /></li>)}</ul>;
          case 'ol': return <ol key={i}>{b.items.map((it, j) => <li key={j}><Inl xs={it} /></li>)}</ol>;
          case 'dmath': return <div key={i} className="dmath"><Math tex={b.v} display /></div>;
        }
      })}
    </div>
  );
});
