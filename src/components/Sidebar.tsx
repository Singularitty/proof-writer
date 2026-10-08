import { useState } from 'react';
import { useStore } from '../store';
import type { Block, Snippet } from '../model/types';
import { uid } from '../model/util';
import { Math } from './Math';
import { useNumbering } from './ProseView';
import { THEOREM_LABEL } from '../model/types';

export function Sidebar() {
  const [tab, setTab] = useState<'outline' | 'snippets' | 'docs'>('snippets');
  return (
    <aside className="sidebar">
      <div className="tabs">
        <button className={tab === 'snippets' ? 'active' : ''} onClick={() => setTab('snippets')}>Snippets</button>
        <button className={tab === 'outline' ? 'active' : ''} onClick={() => setTab('outline')}>Outline</button>
        <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>Documents</button>
      </div>
      <div className="sidebar-body">
        {tab === 'outline' && <Outline />}
        {tab === 'snippets' && <Snippets />}
        {tab === 'docs' && <Docs />}
      </div>
    </aside>
  );
}

function Outline() {
  const blocks = useStore((s) => s.doc.blocks);
  const num = useNumbering();
  const items = blocks
    .map((b: Block) => {
      switch (b.type) {
        case 'heading': return { id: b.id, cls: 'h' + b.level, text: b.text || '(untitled)' };
        case 'theorem': return { id: b.id, cls: 'thm', text: `${num.byId.get(b.id) ?? THEOREM_LABEL[b.kind]}${b.title ? ` (${b.title})` : ''}` };
        case 'rules': return { id: b.id, cls: 'rules', text: `Rules: ${b.rules.map((r) => r.name).filter(Boolean).join(', ') || '…'}` };
        case 'grammar': return { id: b.id, cls: 'grammar', text: `Grammar${b.title ? ': ' + b.title : ''}` };
        case 'derivation': return { id: b.id, cls: 'deriv', text: 'Proof tree' };
        default: return null;
      }
    })
    .filter(Boolean) as { id: string; cls: string; text: string }[];
  return (
    <ul className="outline">
      {items.map((it) => (
        <li key={it.id} className={it.cls}>
          <a onClick={() => { document.getElementById('block-' + it.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); useStore.getState().selectBlock(it.id); }}>{it.text}</a>
        </li>
      ))}
    </ul>
  );
}

function Snippets() {
  const snippets = useStore((s) => s.doc.snippets);
  const update = useStore((s) => s.update);
  const [editing, setEditing] = useState<string | null>(null);
  const set = (id: string, f: (s: Snippet) => void, key?: string) =>
    update((d) => { const s = d.snippets.find((x) => x.id === id); if (s) f(s); }, key);
  const add = (kind: 'math' | 'text') => {
    const id = uid();
    update((d) => { d.snippets.push({ id, kind, name: '', arity: 0, body: '' }); });
    setEditing(id);
  };
  const insert = (s: Snippet) => {
    const t = useStore.getState().insertTarget;
    if (!t) return;
    if (s.kind === 'text') t.insert(`{{${s.name}}}`);
    else t.insert('\\' + s.name + '{}'.repeat(s.arity) + (s.arity ? '' : ' '));
  };
  return (
    <div className="snippets">
      <p className="help">
        <strong>Math snippets</strong> are LaTeX macros: type <code>\name</code> in any math field (with autocomplete). Use <code>#1</code>, <code>#2</code> for arguments. They become <code>\newcommand</code>s in the LaTeX export.
        <br /><strong>Text snippets</strong> expand <code>{'{{name}}'}</code> in prose. Click a snippet to insert it at the cursor.
      </p>
      {snippets.map((s) =>
        editing === s.id ? (
          <div key={s.id} className="snippet editing">
            <div className="row">
              <span className="prefix">{s.kind === 'math' ? '\\' : '{{'}</span>
              <input autoFocus value={s.name} placeholder="name" onChange={(e) => set(s.id, (x) => { x.name = s.kind === 'math' ? e.target.value.replace(/[^A-Za-z]/g, '') : e.target.value.replace(/[^\w-]/g, ''); }, 'sn' + s.id)} />
              {s.kind === 'text' && <span className="prefix">{'}}'}</span>}
              {s.kind === 'math' && (
                <label className="arity">args
                  <input type="number" min={0} max={9} value={s.arity} onChange={(e) => set(s.id, (x) => { x.arity = Math2.max(0, Math2.min(9, +e.target.value || 0)); })} />
                </label>
              )}
            </div>
            <textarea className={s.kind === 'math' ? 'mono' : ''} rows={2} value={s.body} placeholder={s.kind === 'math' ? '#1 \\vdash #2 : #3' : 'By induction on the derivation of'} onChange={(e) => set(s.id, (x) => { x.body = e.target.value; }, 'sb' + s.id)} />
            <input value={s.description ?? ''} placeholder="description (optional)" onChange={(e) => set(s.id, (x) => { x.description = e.target.value; }, 'sd' + s.id)} />
            <div className="row">
              <button className="primary" onClick={() => setEditing(null)}>Done</button>
              <button className="danger" onClick={() => { update((d) => { d.snippets = d.snippets.filter((x) => x.id !== s.id); }); setEditing(null); }}>Delete</button>
            </div>
          </div>
        ) : (
          <div key={s.id} className="snippet" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(s)} title="Click to insert at cursor">
            <div className="snippet-head">
              <code>{s.kind === 'math' ? '\\' + s.name + '{…}'.repeat(s.arity) : `{{${s.name}}}`}</code>
              <button className="mini" onClick={(e) => { e.stopPropagation(); setEditing(s.id); }}>edit</button>
            </div>
            <div className="snippet-prev">
              {s.kind === 'math' ? (s.name ? <Math tex={'\\' + s.name + ['x', 'y', 'z', 'w', 'u', 'v', 'a', 'b', 'c'].slice(0, s.arity).map((a) => `{${a}}`).join('')} /> : null) : <span className="dim">{s.body}</span>}
              {s.description && <span className="dim"> · {s.description}</span>}
            </div>
          </div>
        ),
      )}
      <div className="row">
        <button onClick={() => add('math')}>＋ Math snippet</button>
        <button onClick={() => add('text')}>＋ Text snippet</button>
      </div>
    </div>
  );
}

const Math2 = globalThis.Math;

function Docs() {
  const index = useStore((s) => s.index);
  const docId = useStore((s) => s.docId);
  const { openDoc, newDoc, deleteDoc } = useStore.getState();
  return (
    <div className="docs">
      <div className="row">
        <button onClick={() => newDoc(false)}>＋ New document</button>
        <button onClick={() => newDoc(true)}>＋ STLC example</button>
      </div>
      <ul>
        {index.map((m) => (
          <li key={m.id} className={m.id === docId ? 'active' : ''}>
            <a onClick={() => openDoc(m.id)}>{m.title || 'Untitled'}</a>
            <span className="dim">{new Date(m.updated).toLocaleString()}</span>
            <button className="mini danger" onClick={() => { if (confirm(`Delete "${m.title}"? This cannot be undone.`)) deleteDoc(m.id); }}>×</button>
          </li>
        ))}
      </ul>
      <p className="help">Documents are saved in this browser automatically. Use <em>Save .json</em> to back them up or move them to another machine.</p>
    </div>
  );
}
