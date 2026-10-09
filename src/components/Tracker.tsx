import { useDeferredValue, useMemo } from 'react';
import { useStore, updateBlock } from '../store';
import { checkDoc } from '../check';
import { trackerView, type TrackerGroup, type TrackerInduction, type TrackerView } from '../check/view';
import { useNumbering } from './ProseView';

/** The check report for the open document, a beat behind typing so it never holds up a keystroke. */
export function useTracker(): TrackerView {
  const doc = useDeferredValue(useStore((s) => s.doc));
  return useMemo(() => trackerView(doc, checkDoc(doc)), [doc]);
}

export function jumpToBlock(id: string) {
  // Selecting first lets the editor switch to the section holding this block before scrolling to it.
  useStore.getState().selectBlock(id);
  setTimeout(() => document.getElementById('block-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function Tracker({ view }: { view: TrackerView }) {
  const summary = [view.errors && count(view.errors, 'error'), view.warnings && count(view.warnings, 'warning')].filter(Boolean).join(' · ');
  return (
    <div className="tracker">
      <p className={'tracker-summary' + (summary ? '' : ' clean')}>{summary || 'No problems found'}</p>
      {view.groups.map((g) => <Group key={g.id ?? 'loose'} g={g} view={view} />)}
      {!view.groups.length && <p className="dim">No theorems or lemmas yet.</p>}
    </div>
  );
}

function Group({ g, view }: { g: TrackerGroup; view: TrackerView }) {
  const num = useNumbering();
  const name = g.id ? num.byId.get(g.id) : null;
  return (
    <section className="tk-group">
      <a className="tk-head" onClick={() => g.id && jumpToBlock(g.id)}>
        <span className={'tk-dot ' + g.status} title={g.status === 'ok' ? 'No problems' : g.status} />
        <span className="tk-name">{name ? `${name}${g.title ? ` (${g.title})` : ''}` : g.title}</span>
      </a>
      {g.cites.length > 0 && <div className="tk-line dim">uses {g.cites.map((l) => num.labels.get(l) ?? l).join(', ')}</div>}
      {g.inductions.map((ind) => <Induction key={ind.id} ind={ind} view={view} />)}
      {g.issues.length > 0 && (
        <ul className="tk-issues">
          {g.issues.map((i, k) => (
            <li key={k} className={i.severity}>
              <a onClick={() => jumpToBlock(i.jump)} title="Go to this block"><span className="tk-where">{i.where}</span> {i.message}</a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Induction({ ind, view }: { ind: TrackerInduction; view: TrackerView }) {
  const record = (block: string) => updateBlock<'cases'>(ind.id, (b) => {
    if (block) b.over = { kind: 'rules', block };
    else delete b.over;
  });
  return (
    <div className="tk-line tk-ind">
      <a onClick={() => jumpToBlock(ind.id)}>
        {ind.over ? `Cases: ${ind.covered} of ${ind.expected} rules` : 'Cases: coverage not checked'}
      </a>
      <span className="tk-over">
        over
        <select value={ind.over ?? ''} onChange={(e) => record(e.target.value)} title="The rules this case analysis should cover">
          <option value="">unknown</option>
          {view.rulesBlocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        {ind.source === 'matched' && <button className="mini" onClick={() => record(ind.over!)} title="Worked out from the intro and the case titles. Confirm to record it in the document.">confirm</button>}
      </span>
    </div>
  );
}
