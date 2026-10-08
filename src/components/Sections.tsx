import { useEffect, useMemo } from 'react';
import { useStore, findBlockList } from '../store';
import { makeBlock } from './Blocks';
import type { Block } from '../model/types';

export const PREAMBLE = '__preamble';

export interface Section { id: string; title: string; start: number; end: number }

/** Splits the top-level blocks at each level-1 heading. Blocks before the first one form a preamble. */
export function sectionsOf(blocks: Block[]): Section[] {
  const out: Section[] = [];
  blocks.forEach((b, i) => {
    if (b.type === 'heading' && b.level === 1) {
      if (out.length) out[out.length - 1].end = i;
      else if (i > 0) out.push({ id: PREAMBLE, title: 'Preamble', start: 0, end: i });
      out.push({ id: b.id, title: b.text.trim() || 'Untitled section', start: i, end: blocks.length });
    }
  });
  return out;
}

/** The section currently shown, or null for the whole document (also when the stored one no longer exists). */
export function useCurrentSection(): { sections: Section[]; current: Section | null } {
  const blocks = useStore((s) => s.doc.blocks);
  const id = useStore((s) => s.section);
  const sections = useMemo(() => sectionsOf(blocks), [blocks]);
  return { sections, current: sections.find((s) => s.id === id) ?? null };
}

/** Top-level index of the block containing `id` (itself, or the top-level block it is nested in). */
function topLevelIndex(blocks: Block[], id: string): number {
  const direct = blocks.findIndex((b) => b.id === id);
  if (direct >= 0) return direct;
  return blocks.findIndex((b) => {
    const json = JSON.stringify(b);
    return json.includes(`"id":"${id}"`);
  });
}

export function SectionTabs() {
  const blocks = useStore((s) => s.doc.blocks);
  const selected = useStore((s) => s.selectedBlock);
  const setSection = useStore((s) => s.setSection);
  const { sections, current } = useCurrentSection();

  // Selecting a block outside the shown section (outline click, a newly inserted
  // heading, undo) switches to the section that contains it.
  useEffect(() => {
    if (!current || !selected) return;
    const i = topLevelIndex(blocks, selected);
    if (i < 0 || (i >= current.start && i < current.end)) return;
    const s = sections.find((x) => i >= x.start && i < x.end);
    if (s) setSection(s.id);
  }, [selected, blocks]); // eslint-disable-line

  const addSection = () => {
    const h = makeBlock('heading');
    if (h.type === 'heading') { h.level = 1; h.text = ''; }
    const after = current ? blocks[current.end - 1]?.id : undefined;
    useStore.getState().update((d) => {
      if (after) {
        const list = findBlockList(d.blocks, after)!;
        list.splice(list.findIndex((b) => b.id === after) + 1, 0, h);
      } else d.blocks.push(h);
    });
    setSection(h.id);
    useStore.getState().selectBlock(h.id);
  };

  if (!sections.length) {
    return (
      <nav className="section-tabs">
        <span className="section-hint">Split the document into sections you can edit one at a time:</span>
        <button className="section-add" onClick={addSection}>＋ Section</button>
      </nav>
    );
  }
  let n = 0;
  return (
    <nav className="section-tabs" aria-label="Sections">
      <button className={'section-tab' + (current ? '' : ' active')} onClick={() => setSection(null)}>All</button>
      {sections.map((s) => (
        <button
          key={s.id}
          className={'section-tab' + (current?.id === s.id ? ' active' : '')}
          onClick={() => { setSection(s.id); useStore.getState().selectBlock(null); document.querySelector('.editor')?.scrollTo({ top: 0 }); }}
          title={s.title}
        >
          {s.id !== PREAMBLE && <span className="section-num">{++n}</span>}
          {s.title}
        </button>
      ))}
      <button className="section-add" onClick={addSection} title="Add a section after the current one">＋ Section</button>
    </nav>
  );
}

/** "← Previous / Next →" links under a section. */
export function SectionPager() {
  const setSection = useStore((s) => s.setSection);
  const { sections, current } = useCurrentSection();
  if (!current) return null;
  const i = sections.indexOf(current);
  const go = (s: Section) => { setSection(s.id); useStore.getState().selectBlock(null); document.querySelector('.editor')?.scrollTo({ top: 0 }); };
  const prev = sections[i - 1];
  const next = sections[i + 1];
  return (
    <div className="section-pager">
      {prev ? <button onClick={() => go(prev)}>← {prev.title}</button> : <span />}
      {next ? <button onClick={() => go(next)}>{next.title} →</button> : <span />}
    </div>
  );
}
