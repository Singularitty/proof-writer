import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useStore, findBlock } from '../store';
import { collapsedAround, findInDoc, replaceAll, replaceHit, type Hit } from '../model/search';
import { jumpToBlock } from './Tracker';
import { Icon } from './Icon';

interface FindBarProps {
  query: string;
  onQuery: (q: string) => void;
  matchCase: boolean;
  onMatchCase: (on: boolean) => void;
  /** Number of matches, and which one is current (from 0; -1 for none). */
  count: number;
  current: number;
  onStep: (by: 1 | -1) => void;
  onClose: () => void;
  /** Changes each time the bar is asked for, to take the keyboard again. */
  focus: number;
  placeholder: string;
  children?: ReactNode;
}

/** The row a search is typed in: the query, how many matches, and stepping through them. */
export function FindBar({ query, onQuery, matchCase, onMatchCase, count, current, onStep, onClose, focus, placeholder, children }: FindBarProps) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, [focus]);
  return (
    <div className="find-bar" role="search" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <input
        ref={input}
        className="find-query"
        value={query}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onStep(e.shiftKey ? -1 : 1); } }}
      />
      <span className={'find-count' + (query && !count ? ' none' : '')} aria-live="polite">{query ? (count ? `${current + 1} of ${count}` : 'No matches') : ''}</span>
      <button className="mini" disabled={!count} onClick={() => onStep(-1)} title="Previous match (Shift+Enter)" aria-label="Previous match">↑</button>
      <button className="mini" disabled={!count} onClick={() => onStep(1)} title="Next match (Enter)" aria-label="Next match">↓</button>
      <button className={'mini' + (matchCase ? ' active' : '')} aria-pressed={matchCase} onClick={() => onMatchCase(!matchCase)} title="Match case">Aa</button>
      {children}
      <span className="grow" />
      <button className="mini" onClick={onClose} title="Close (Esc)" aria-label="Close search">×</button>
    </div>
  );
}

/** Search and replace over what the document says, in every section, whether or not it is on screen. */
export function EditorFind() {
  const focus = useStore((s) => s.find.editor);
  return focus ? <EditorFindBar focus={focus} /> : null;
}

/** The text around a match, so it can be told apart from the others in its block. */
function Excerpt({ hit }: { hit: Hit }) {
  const from = Math.max(0, hit.start - 40), to = Math.min(hit.text.length, hit.end + 60);
  return (
    <div className="find-excerpt" title="The match, as written in the block marked below">
      {from > 0 && '…'}{hit.text.slice(from, hit.start)}<mark>{hit.text.slice(hit.start, hit.end)}</mark>{hit.text.slice(hit.end, to)}{to < hit.text.length && '…'}
    </div>
  );
}

function EditorFindBar({ focus }: { focus: number }) {
  const blocks = useStore((s) => s.doc.blocks);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [replacement, setReplacement] = useState('');
  const [at, setAt] = useState(0);
  const hits = findInDoc(blocks, query, { matchCase });
  const current = hits.length ? Math.min(at, hits.length - 1) : -1;
  const hit = hits[current];

  useEffect(() => () => useStore.getState().setFoundBlock(null), []);
  // the mark follows the current match, also when an edit moves or removes it
  useEffect(() => { useStore.getState().setFoundBlock(hit?.block ?? null); }, [hit?.block]);

  /** Brings a match into view: its section, any collapsed proof around it, then the block itself. */
  const show = (h: Hit | undefined) => {
    if (!h) return;
    const s = useStore.getState();
    const closed = collapsedAround(s.doc.blocks, h.block);
    if (closed.length) s.update((d) => { for (const id of closed) { const b = findBlock(d.blocks, id); if (b?.type === 'theorem') b.collapsed = false; } });
    jumpToBlock(h.block);
  };
  const search = (q: string, mc: boolean) => {
    setQuery(q); setMatchCase(mc); setAt(0);
    show(findInDoc(blocks, q, { matchCase: mc })[0]);
  };
  const step = (by: 1 | -1) => {
    if (!hits.length) return;
    const n = (current + by + hits.length) % hits.length;
    setAt(n);
    show(hits[n]);
  };
  const replaceOne = () => {
    if (!hit) return;
    useStore.getState().update((d) => { replaceHit(d.blocks, hit, replacement); });
    const left = findInDoc(useStore.getState().doc.blocks, query, { matchCase });
    // the next match now has this one's number, unless the new text is itself a match
    const stays = left[current]?.field === hit.field && left[current].start === hit.start;
    const n = left.length ? (current + (stays ? 1 : 0)) % left.length : 0;
    setAt(n);
    show(left[n]);
  };
  const replaceEvery = () => { useStore.getState().update((d) => { replaceAll(d.blocks, query, replacement, { matchCase }); }); setAt(0); };

  return (
    <div className="find">
      <FindBar
        query={query} onQuery={(q) => search(q, matchCase)} matchCase={matchCase} onMatchCase={(mc) => search(query, mc)}
        count={hits.length} current={current} onStep={step} onClose={() => useStore.getState().closeFind('editor')}
        focus={focus} placeholder="Find in the document"
      >
        <button className={'mini' + (replacing ? ' active' : '')} aria-pressed={replacing} onClick={() => setReplacing(!replacing)} title="Show the replace row">Replace…</button>
      </FindBar>
      {replacing && (
        <div className="find-bar" onKeyDown={(e) => { if (e.key === 'Escape') useStore.getState().closeFind('editor'); }}>
          <input className="find-query" value={replacement} placeholder="Replace with" aria-label="Replace with" spellCheck={false} onChange={(e) => setReplacement(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); replaceOne(); } }} />
          <button className="mini" disabled={!hit} onClick={replaceOne} title="Replace this match and go to the next (Enter)">Replace</button>
          <button className="mini" disabled={!hit} onClick={replaceEvery} title="Replace every match in the document; one Undo brings them all back">Replace all</button>
        </div>
      )}
      {hit && <Excerpt hit={hit} />}
    </div>
  );
}

/** A button that opens the search of one pane. */
export function FindButton({ where }: { where: 'editor' | 'preview' }) {
  const label = where === 'editor' ? 'Find and replace in the document (Ctrl+F)' : 'Find in the preview (Ctrl+F)';
  return <button onClick={() => useStore.getState().openFind(where)} title={label} aria-label={label}><Icon name="search" /></button>;
}
