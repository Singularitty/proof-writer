import { useEffect, useRef, useState } from 'react';
import type { Block, BlockType, CaseItem, GrammarProduction, Rule, TheoremKind } from '../model/types';
import { THEOREM_LABEL } from '../model/types';
import { findBlockList, updateBlock, useStore } from '../store';
import { uncoveredRules } from '../check/coverage';
import { cloneFresh, uid } from '../model/util';
import { newNode, allRules } from '../model/tree';
import { MathField, ProseField, TextInput } from './Fields';
import { TreeEditor, RuleView } from './TreeEditor';
import { useNumbering } from './ProseView';

// ---------- block factory ----------

export const BLOCK_TYPES: { type: BlockType; label: string; hint: string }[] = [
  { type: 'text', label: 'Text', hint: 'Paragraphs with $math$' },
  { type: 'heading', label: 'Heading', hint: 'Section title' },
  { type: 'grammar', label: 'Grammar', hint: 'BNF syntax definitions' },
  { type: 'rules', label: 'Rules', hint: 'Inference rules' },
  { type: 'derivation', label: 'Proof tree', hint: 'A derivation, built by clicking' },
  { type: 'theorem', label: 'Lemma / Theorem', hint: 'Statement with a proof' },
  { type: 'cases', label: 'Case analysis', hint: 'Induction / case split' },
  { type: 'raw', label: 'Raw code', hint: 'Verbatim Typst + LaTeX' },
];

export function makeBlock(type: BlockType): Block {
  const id = uid();
  switch (type) {
    case 'heading': return { id, type, level: 1, text: '' };
    case 'text': return { id, type, text: '' };
    case 'grammar': return { id, type, title: '', rows: [{ id: uid(), category: '', metavar: '', alternatives: [''] }] };
    case 'rules': return { id, type, title: '', judgment: '', rules: [{ id: uid(), name: '', premises: [''], conclusion: '' }] };
    case 'derivation': return { id, type, caption: '', root: newNode() };
    case 'theorem': return { id, type, kind: 'lemma', title: '', label: '', statement: '', proof: [{ id: uid(), type: 'text', text: '' }] };
    case 'cases': return { id, type, intro: '', cases: [{ id: uid(), title: '', body: [{ id: uid(), type: 'text', text: '' }] }] };
    case 'raw': return { id, type, typst: '', latex: '' };
  }
}

// ---------- list of blocks ----------

/** `offset`/`total` place a slice of a longer list (one section of the document), so move buttons stay correct. */
export function BlockList({ blocks, nested, offset = 0, total }: { blocks: Block[]; nested?: boolean; offset?: number; total?: number }) {
  // Inside a section, inserting above its heading would land in the previous section.
  const leadingInsert = offset === 0 || !(blocks[0]?.type === 'heading' && blocks[0].level === 1);
  return (
    <div className={'block-list' + (nested ? ' nested' : '')}>
      {blocks.map((b, i) => (
        <div key={b.id}>
          {i === 0 && leadingInsert && <InsertBar before={b.id} nested={nested} />}
          <BlockFrame block={b} index={offset + i} count={total ?? blocks.length} nested={nested} />
          <InsertBar after={b.id} nested={nested} />
        </div>
      ))}
      {blocks.length === 0 && <InsertBar nested={nested} emptyListOf={blocks} />}
    </div>
  );
}

function InsertBar({ before, after, nested, emptyListOf }: { before?: string; after?: string; nested?: boolean; emptyListOf?: Block[] }) {
  const [open, setOpen] = useState(false);
  /** Open upwards when the button is too near the bottom of the window for the menu to fit below it. */
  const [up, setUp] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const r = bar.current?.getBoundingClientRect();
    if (r) setUp(window.innerHeight - r.bottom < 360 && r.top > 360);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (!bar.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [open]);
  const update = useStore((s) => s.update);
  const insert = (type: BlockType) => {
    const nb = makeBlock(type);
    update((d) => {
      const ref = before ?? after;
      if (ref) {
        const list = findBlockList(d.blocks, ref);
        if (!list) return;
        const i = list.findIndex((x) => x.id === ref);
        list.splice(after ? i + 1 : i, 0, nb);
      } else if (emptyListOf) {
        // find the (draft) empty list by identity of its owner: fall back to top level
        d.blocks.push(nb);
      }
    });
    setOpen(false);
    useStore.getState().selectBlock(nb.id);
  };
  const types = nested ? BLOCK_TYPES.filter((t) => t.type !== 'heading') : BLOCK_TYPES;
  return (
    <div ref={bar} className={'insert-bar' + (open ? ' open' : '')}>
      <button className="insert-btn" onClick={() => setOpen(!open)} title="Insert block" aria-label="Insert block">＋</button>
      {open && (
        <div className={'insert-menu' + (up ? ' up' : '')} onMouseLeave={() => setOpen(false)}>
          {types.map((t) => (
            <button key={t.type} onClick={() => insert(t.type)}>
              <strong>{t.label}</strong>
              <span>{t.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const TYPE_NAMES: Record<BlockType, string> = {
  heading: 'Heading', text: 'Text', grammar: 'Grammar', rules: 'Rules', derivation: 'Proof tree',
  theorem: 'Theorem', cases: 'Cases', raw: 'Raw',
};

function BlockFrame({ block, index, count, nested }: { block: Block; index: number; count: number; nested?: boolean }) {
  const update = useStore((s) => s.update);
  const selected = useStore((s) => s.selectedBlock === block.id);
  const selectBlock = useStore((s) => s.selectBlock);
  const move = (d: -1 | 1) => update((doc) => {
    const list = findBlockList(doc.blocks, block.id);
    if (!list) return;
    const i = list.findIndex((x) => x.id === block.id);
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
  });
  const remove = () => update((doc) => {
    const list = findBlockList(doc.blocks, block.id);
    if (!list) return;
    list.splice(list.findIndex((x) => x.id === block.id), 1);
  });
  const duplicate = () => update((doc) => {
    const list = findBlockList(doc.blocks, block.id);
    if (!list) return;
    const i = list.findIndex((x) => x.id === block.id);
    list.splice(i + 1, 0, cloneFresh(JSON.parse(JSON.stringify(list[i]))));
  });
  return (
    <section
      id={'block-' + block.id}
      className={`block block-${block.type}` + (selected ? ' selected' : '') + (nested ? ' nested' : '')}
      onMouseDown={() => { if (!selected) selectBlock(block.id); }}
    >
      <div className="block-gutter">
        <span className="block-type">{TYPE_NAMES[block.type]}</span>
        <div className="block-actions">
          <button onClick={() => move(-1)} disabled={index === 0} title="Move up" aria-label="Move up">↑</button>
          <button onClick={() => move(1)} disabled={index === count - 1} title="Move down" aria-label="Move down">↓</button>
          <button onClick={duplicate} title="Duplicate" aria-label="Duplicate">⧉</button>
          <button onClick={() => useStore.getState().showInPdf(block.id)} title="Show in PDF" aria-label="Show in PDF">⇢</button>
          <button className="danger" onClick={remove} title="Delete block" aria-label="Delete block">✕</button>
        </div>
      </div>
      <div className="block-body">
        <BlockEditor block={block} fresh={selected} />
      </div>
    </section>
  );
}

function BlockEditor({ block, fresh }: { block: Block; fresh: boolean }) {
  switch (block.type) {
    case 'heading': return <HeadingEditor b={block} fresh={fresh} />;
    case 'text': return <ProseField value={block.text} onChange={(v) => updateBlock<'text'>(block.id, (b) => { b.text = v; }, 't' + block.id)} startEditing={fresh && !block.text} />;
    case 'grammar': return <GrammarEditor b={block} />;
    case 'rules': return <RulesEditor b={block} />;
    case 'derivation': return <DerivationEditor b={block} />;
    case 'theorem': return <TheoremEditor b={block} fresh={fresh} />;
    case 'cases': return <CasesEditor b={block} />;
    case 'raw': return <RawEditor b={block} />;
  }
}

type B<T extends BlockType> = Extract<Block, { type: T }>;

function HeadingEditor({ b, fresh }: { b: B<'heading'>; fresh: boolean }) {
  return (
    <div className={'heading-editor h' + b.level}>
      <select value={b.level} onChange={(e) => updateBlock<'heading'>(b.id, (x) => { x.level = +e.target.value as 1 | 2 | 3; })}>
        <option value={1}>H1</option><option value={2}>H2</option><option value={3}>H3</option>
      </select>
      <TextInput value={b.text} placeholder="Heading" autoFocus={fresh && !b.text} onChange={(v) => updateBlock<'heading'>(b.id, (x) => { x.text = v; }, 'h' + b.id)} />
    </div>
  );
}

// ---------- grammar ----------

function GrammarEditor({ b }: { b: B<'grammar'> }) {
  const set = (f: (x: B<'grammar'>) => void, key?: string) => updateBlock<'grammar'>(b.id, f as never, key);
  const row = (rid: string, f: (r: GrammarProduction) => void, key?: string) =>
    set((x) => { const r = x.rows.find((y) => y.id === rid); if (r) f(r); }, key);
  return (
    <div className="grammar-editor">
      <TextInput className="block-title" value={b.title} placeholder="Title (optional)" onChange={(v) => set((x) => { x.title = v; }, 'gt' + b.id)} />
      <table className="grammar">
        <tbody>
          {b.rows.map((r, ri) => (
            <tr key={r.id}>
              <td className="cat"><TextInput value={r.category} placeholder="Category" onChange={(v) => row(r.id, (y) => { y.category = v; }, 'gc' + r.id)} /></td>
              <td className="mv"><MathField value={r.metavar} placeholder="\tau" onChange={(v) => row(r.id, (y) => { y.metavar = v; }, 'gm' + r.id)} /></td>
              <td className="bnf">::=</td>
              <td className="alts">
                {r.alternatives.map((a, ai) => (
                  <span key={ai} className="alt">
                    {ai > 0 && <span className="bar">|</span>}
                    <MathField value={a} placeholder="production" onChange={(v) => row(r.id, (y) => { y.alternatives[ai] = v; }, `ga${r.id}${ai}`)} />
                    <button className="mini" title="Remove alternative" aria-label="Remove alternative" onClick={() => row(r.id, (y) => { y.alternatives.splice(ai, 1); })}>×</button>
                  </span>
                ))}
                <button className="mini add" onClick={() => row(r.id, (y) => { y.alternatives.push(''); })}>＋ alt</button>
              </td>
              <td className="row-actions">
                <button aria-label="Move up" title="Move up" className="mini" disabled={ri === 0} onClick={() => set((x) => { [x.rows[ri - 1], x.rows[ri]] = [x.rows[ri], x.rows[ri - 1]]; })}>↑</button>
                <button aria-label="Remove" title="Remove" className="mini" onClick={() => set((x) => { x.rows.splice(ri, 1); })}>×</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="add-row" onClick={() => set((x) => { x.rows.push({ id: uid(), category: '', metavar: '', alternatives: [''] }); })}>＋ Syntactic category</button>
    </div>
  );
}

// ---------- rules ----------

function RulesEditor({ b }: { b: B<'rules'> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const set = (f: (x: B<'rules'>) => void, key?: string) => updateBlock<'rules'>(b.id, f as never, key);
  return (
    <div className="rules-editor">
      <div className="rules-head">
        <TextInput className="block-title" value={b.title} placeholder="Title (optional)" onChange={(v) => set((x) => { x.title = v; }, 'rt' + b.id)} />
        <span className="judgment-form">
          <span className="lbl">Judgment form</span>
          <MathField value={b.judgment ?? ''} placeholder="\Gamma \vdash e : \tau" className="boxed" onChange={(v) => set((x) => { x.judgment = v; }, 'rj' + b.id)} />
        </span>
      </div>
      <div className="rules-grid">
        {b.rules.map((r, i) => (
          <RuleCard
            key={r.id}
            rule={r}
            editing={editing === r.id}
            onEdit={() => setEditing(editing === r.id ? null : r.id)}
            set={(f, key) => set((x) => { const y = x.rules.find((z) => z.id === r.id); if (y) f(y); }, key)}
            remove={() => set((x) => { x.rules.splice(i, 1); })}
            move={(d) => set((x) => { const j = i + d; if (j < 0 || j >= x.rules.length) return; [x.rules[i], x.rules[j]] = [x.rules[j], x.rules[i]]; })}
            duplicate={() => set((x) => { x.rules.splice(i + 1, 0, { ...cloneFresh(JSON.parse(JSON.stringify(r))), name: r.name + "'" }); })}
          />
        ))}
        <button
          className="add-rule"
          onClick={() => {
            const id = uid();
            set((x) => { x.rules.push({ id, name: '', premises: [''], conclusion: '' }); });
            setEditing(id);
          }}
        >＋ Rule</button>
      </div>
    </div>
  );
}

function RuleCard({ rule, editing, onEdit, set, remove, move, duplicate }: {
  rule: Rule; editing: boolean; onEdit: () => void;
  set: (f: (r: Rule) => void, key?: string) => void; remove: () => void; move: (d: -1 | 1) => void; duplicate: () => void;
}) {
  if (!editing) {
    return (
      <div className="rule-card" onClick={onEdit} title="Click to edit">
        <RuleView rule={rule} />
      </div>
    );
  }
  return (
    <div className="rule-card editing">
      <div className="rule-form">
        <div className="row">
          <label>Name</label>
          <TextInput value={rule.name} placeholder="T-App" onChange={(v) => set((r) => { r.name = v; }, 'rn' + rule.id)} />
        </div>
        <div className="row">
          <label>Premises</label>
          <div className="premises">
            {rule.premises.map((p, i) => (
              <span key={i} className="premise">
                <MathField value={p} placeholder="premise" startEditing={!p && i === rule.premises.length - 1 && !rule.conclusion} onChange={(v) => set((r) => { r.premises[i] = v; }, `rp${rule.id}${i}`)} />
                <button aria-label="Remove" title="Remove" className="mini" onClick={() => set((r) => { r.premises.splice(i, 1); })}>×</button>
              </span>
            ))}
            <button className="mini add" onClick={() => set((r) => { r.premises.push(''); })}>＋ premise</button>
          </div>
        </div>
        <div className="row">
          <label>Conclusion</label>
          <MathField value={rule.conclusion} placeholder="conclusion" onChange={(v) => set((r) => { r.conclusion = v; }, 'rc' + rule.id)} />
        </div>
        <div className="row">
          <label>Side condition</label>
          <MathField value={rule.side ?? ''} placeholder="optional, e.g. x \notin \mathrm{dom}(\Gamma)" onChange={(v) => set((r) => { r.side = v || undefined; }, 'rs' + rule.id)} />
        </div>
        <div className="preview-row"><RuleView rule={rule} /></div>
        <div className="row actions">
          <button onClick={onEdit} className="primary">Done</button>
          <button aria-label="Move left" title="Move left" onClick={() => move(-1)}>←</button>
          <button aria-label="Move right" title="Move right" onClick={() => move(1)}>→</button>
          <button onClick={duplicate}>Duplicate</button>
          <button className="danger" onClick={remove}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ---------- derivation ----------

function DerivationEditor({ b }: { b: B<'derivation'> }) {
  return (
    <div className="derivation-editor">
      <TreeEditor blockId={b.id} root={b.root} unknowns={b.unknowns ?? []} />
      <ProseField inline value={b.caption ?? ''} placeholder="Caption (optional)" className="caption" onChange={(v) => updateBlock<'derivation'>(b.id, (x) => { x.caption = v; }, 'dc' + b.id)} />
    </div>
  );
}

// ---------- theorem ----------

function TheoremEditor({ b, fresh }: { b: B<'theorem'>; fresh: boolean }) {
  const num = useNumbering();
  const set = (f: (x: B<'theorem'>) => void, key?: string) => updateBlock<'theorem'>(b.id, f as never, key);
  return (
    <div className={'theorem-editor kind-' + b.kind}>
      <div className="thm-head">
        <select value={b.kind} onChange={(e) => set((x) => { x.kind = e.target.value as TheoremKind; })}>
          {Object.entries(THEOREM_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <strong className="thm-num">{num.byId.get(b.id)}</strong>
        <TextInput className="thm-title" value={b.title} placeholder="Name (optional)" onChange={(v) => set((x) => { x.title = v; }, 'tt' + b.id)} />
        <span className="thm-label">
          <span className="lbl">label</span>
          <TextInput value={b.label} placeholder="lem:subst" onChange={(v) => set((x) => { x.label = v; }, 'tl' + b.id)} />
        </span>
      </div>
      <ProseField className="thm-statement" value={b.statement} placeholder="Statement, e.g. If $\Gamma \vdash e : \tau$ and … then …" onChange={(v) => set((x) => { x.statement = v; }, 'ts' + b.id)} startEditing={fresh && !b.statement} />
      {b.kind !== 'definition' && (
        <div className={'proof' + (b.collapsed ? ' collapsed' : '')}>
          <div className="proof-label">
            <button className="link" aria-expanded={!b.collapsed} onClick={() => set((x) => { x.collapsed = !x.collapsed; })}>
              <span className="chev">{b.collapsed ? '▸' : '▾'}</span> <em>Proof.</em>
            </button>
            {!b.proof && <button className="mini add" onClick={() => set((x) => { x.proof = [{ id: uid(), type: 'text', text: '' }]; })}>＋ Add proof</button>}
          </div>
          {!b.collapsed && b.proof && <NestedBlocks owner={b.id} blocks={b.proof} path="proof" />}
        </div>
      )}
    </div>
  );
}

/** A nested block list whose empty state needs to know its owner. */
function NestedBlocks({ owner, blocks, path, caseId }: { owner: string; blocks: Block[]; path: 'proof' | 'case'; caseId?: string }) {
  if (blocks.length > 0) return <BlockList blocks={blocks} nested />;
  const add = (type: BlockType) => {
    const nb = makeBlock(type);
    if (path === 'proof') updateBlock<'theorem'>(owner, (x) => { (x.proof ??= []).push(nb); });
    else updateBlock<'cases'>(owner, (x) => { x.cases.find((c) => c.id === caseId)?.body.push(nb); });
  };
  return (
    <div className="empty-nested">
      {BLOCK_TYPES.filter((t) => t.type !== 'heading').map((t) => (
        <button key={t.type} className="mini" onClick={() => add(t.type)}>＋ {t.label}</button>
      ))}
    </div>
  );
}

// ---------- cases ----------

function CasesEditor({ b }: { b: B<'cases'> }) {
  const doc = useStore((s) => s.doc);
  const [gen, setGen] = useState(false);
  const set = (f: (x: B<'cases'>) => void, key?: string) => updateBlock<'cases'>(b.id, f as never, key);
  const ruleBlocks = doc.blocks.filter((x): x is B<'rules'> => x.type === 'rules');
  const generate = (rb: B<'rules'>) => {
    const snippets = new Map(useStore.getState().doc.snippets.filter((s) => s.kind === 'text').map((s) => [s.name, s.body]));
    set((x) => {
      // only the rules that have no case yet, judged on the cases as they are now
      const kept = x.cases.filter((c) => c.title.trim() || c.body.some((bb) => bb.type !== 'text' || bb.text.trim()));
      const missing = uncoveredRules(kept.map((c) => c.title), rb.rules.map((r) => r.name), snippets);
      x.cases = [...kept, ...missing.map((name): CaseItem => ({ id: uid(), title: `[[${name}]]`, body: [{ id: uid(), type: 'text', text: '' }] }))];
    });
    setGen(false);
  };
  void allRules;
  return (
    <div className="cases-editor">
      <ProseField value={b.intro} placeholder="e.g. By induction on the derivation of $\Gamma \vdash e : \tau$." onChange={(v) => set((x) => { x.intro = v; }, 'ci' + b.id)} />
      {b.cases.map((c, i) => (
        <div key={c.id} className="case">
          <div className="case-head">
            <strong>Case</strong>
            <ProseField inline value={c.title} placeholder="[[T-App]]" onChange={(v) => set((x) => { x.cases[i].title = v; }, 'ct' + c.id)} />
            <span className="grow" />
            <button aria-label="Move up" title="Move up" className="mini" disabled={i === 0} onClick={() => set((x) => { [x.cases[i - 1], x.cases[i]] = [x.cases[i], x.cases[i - 1]]; })}>↑</button>
            <button aria-label="Remove" title="Remove" className="mini" onClick={() => set((x) => { x.cases.splice(i, 1); })}>×</button>
          </div>
          <div className="case-body">
            <NestedBlocks owner={b.id} blocks={c.body} path="case" caseId={c.id} />
          </div>
        </div>
      ))}
      <div className="case-actions">
        <button className="mini add" onClick={() => set((x) => { x.cases.push({ id: uid(), title: '', body: [{ id: uid(), type: 'text', text: '' }] }); })}>＋ Case</button>
        <span className="picker-wrap">
          <button className="mini add" onClick={() => setGen(!gen)} disabled={!ruleBlocks.length}>＋ One case per rule ▾</button>
          {gen && (
            <div className="menu">
              {ruleBlocks.map((rb) => (
                <button key={rb.id} onClick={() => generate(rb)}>
                  {rb.title || rb.judgment || 'Rules'} <span className="dim">({rb.rules.map((r) => r.name).join(', ')})</span>
                </button>
              ))}
            </div>
          )}
        </span>
      </div>
    </div>
  );
}

// ---------- raw ----------

function RawEditor({ b }: { b: B<'raw'> }) {
  return (
    <div className="raw-editor">
      <label>Typst</label>
      <textarea className="mono" value={b.typst} rows={3} onChange={(e) => updateBlock<'raw'>(b.id, (x) => { x.typst = e.target.value; }, 'rwt' + b.id)} />
      <label>LaTeX</label>
      <textarea className="mono" value={b.latex} rows={3} onChange={(e) => updateBlock<'raw'>(b.id, (x) => { x.latex = e.target.value; }, 'rwl' + b.id)} />
    </div>
  );
}
