import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProofNode, Rule } from '../model/types';
import { updateBlock, useStore } from '../store';
import { allRules, applyRule, countOpen, docMacros, findNode, newNode, substituteTree, treeMetavars } from '../model/tree';
import { matchJudgment } from '../latex/match';
import { cloneFresh } from '../model/util';
import { MathField } from './Fields';
import { Math } from './Math';

interface Props {
  blockId: string;
  root: ProofNode;
  unknowns: string[];
}

type Op = (root: ProofNode) => void;

export function TreeEditor({ blockId, root, unknowns }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const mutate = (op: Op, key?: string) =>
    updateBlock<'derivation'>(blockId, (b) => op(b.root as ProofNode), key);

  const sel = selected ? findNode(root, selected) : null;
  const open = countOpen(root);

  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(null), 4000); return () => clearTimeout(t); } }, [notice]);

  const addPremise = (id: string) => {
    const n = newNode();
    mutate((r) => { findNode(r, id)?.node.children.push(n); });
    setSelected(n.id);
    setEditing(n.id);
  };
  const extendBelow = (id: string) => {
    const n = newNode();
    updateBlock<'derivation'>(blockId, (b) => {
      const f = findNode(b.root as ProofNode, id);
      if (!f) return;
      if (!f.parent) b.root = { ...n, children: [b.root] };
      else f.parent.children[f.index] = { ...n, children: [f.node] };
    });
    setSelected(n.id);
    setEditing(n.id);
  };
  const remove = (id: string) => {
    const f = findNode(root, id);
    if (!f) return;
    if (!f.parent) {
      mutate((r) => { r.children = []; r.judgment = ''; r.rule = undefined; r.ruleRef = undefined; });
      return;
    }
    mutate((r) => { const g = findNode(r, id); g?.parent?.children.splice(g.index, 1); });
    setSelected(f.parent.id);
  };
  const move = (id: string, d: -1 | 1) => mutate((r) => {
    const g = findNode(r, id);
    if (!g?.parent) return;
    const j = g.index + d;
    if (j < 0 || j >= g.parent.children.length) return;
    const arr = g.parent.children;
    [arr[g.index], arr[j]] = [arr[j], arr[g.index]];
  });
  const duplicate = (id: string) => mutate((r) => {
    const g = findNode(r, id);
    if (!g?.parent) return;
    g.parent.children.splice(g.index + 1, 0, cloneFresh(g.node));
  });
  const toggle = (id: string, k: 'leaf' | 'elided') => mutate((r) => {
    const g = findNode(r, id);
    if (g) g.node[k] = !g.node[k];
  });

  const doc = useStore((s) => s.doc);
  const macros = useMemo(() => docMacros(doc), [doc.snippets]); // eslint-disable-line

  const apply = (rule: Rule) => {
    if (!sel) return;
    const a = applyRule(rule, sel.node.judgment, macros, unknowns, treeMetavars(root));
    const sideCount = rule.side?.trim() ? 1 : 0;
    const prem = a.premises;
    // premises that no rule can derive (e.g. x:\tau \in \Gamma) are side conditions: no open goal
    const rules = allRules(doc);
    const derivable = (p: string) => rules.some(({ rule: r }) => !!matchJudgment(r.conclusion, p, macros, [...unknowns, ...a.fresh]));
    updateBlock<'derivation'>(blockId, (b) => {
      const g = findNode(b.root as ProofNode, sel.node.id);
      if (!g) return;
      const n = g.node;
      n.judgment = a.judgment;
      n.rule = rule.name;
      n.ruleRef = rule.id;
      n.elided = false;
      n.leaf = false;
      const kids = n.children;
      prem.forEach((p, i) => {
        const isSide = i >= prem.length - sideCount || !derivable(p);
        if (kids[i]) {
          if (!kids[i].judgment.trim() || kids[i].children.length === 0) kids[i].judgment = p;
        } else kids.push({ ...newNode(p), leaf: isSide || undefined });
        if (kids[i] && isSide && kids[i].children.length === 0) kids[i].leaf = true;
      });
      // drop surplus *empty* children
      n.children = kids.filter((k, i) => i < prem.length || k.judgment.trim() || k.children.length);
      if (a.matched) {
        substituteTree(b.root as ProofNode, a.solved);
        const present = treeMetavars(b.root as ProofNode);
        b.unknowns = [...new Set([...(b.unknowns ?? []).filter((u) => !a.solved.has(u)), ...a.fresh])].filter((u) => present.has(u));
      }
    });
    setPicker(false);
    if (!a.matched) setNotice(`The conclusion of ${rule.name} did not match this judgment, so its premises were copied without instantiation.`);
    else if (a.solved.size) setNotice(`Solved ${[...a.solved].map(([k, v]) => `${k} = ${v}`).join(', ')}.`);
  };
  const instantiateUnknown = (u: string, v: string) => {
    if (!v.trim()) return;
    updateBlock<'derivation'>(blockId, (b) => {
      substituteTree(b.root as ProofNode, new Map([[u, v]]));
      b.unknowns = (b.unknowns ?? []).filter((x) => x !== u);
    });
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || editingLabel || picker || !sel) return;
    if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') return;
    const id = sel.node.id;
    const k = e.key;
    if (k === 'Enter') { setEditing(id); e.preventDefault(); }
    else if (k === 'p' || k === '+') { addPremise(id); e.preventDefault(); }
    else if (k === 'r') { setPicker(true); e.preventDefault(); }
    else if (k === 'n') { setEditingLabel(id); e.preventDefault(); }
    else if (k === 'b') { extendBelow(id); e.preventDefault(); }
    else if (k === 'Delete' || k === 'Backspace') { remove(id); e.preventDefault(); }
    else if (k === 'ArrowUp') { if (sel.node.children[0]) setSelected(sel.node.children[0].id); e.preventDefault(); }
    else if (k === 'ArrowDown') { if (sel.parent) setSelected(sel.parent.id); e.preventDefault(); }
    else if (k === 'ArrowLeft' && sel.parent) { const s = sel.parent.children[sel.index - 1]; if (s) setSelected(s.id); e.preventDefault(); }
    else if (k === 'ArrowRight' && sel.parent) { const s = sel.parent.children[sel.index + 1]; if (s) setSelected(s.id); e.preventDefault(); }
    else if (k === 'Escape') setSelected(null);
  };

  return (
    <div className="tree-editor" ref={box} tabIndex={-1} onKeyDown={onKey} onClick={() => { setSelected(null); setPicker(false); }}>
      <div className="tree-toolbar" onClick={(e) => e.stopPropagation()}>
        {sel ? (
          <>
            <div className="picker-wrap">
              <button className={'primary-soft' + (picker ? ' active' : '')} onClick={() => setPicker(!picker)} title="Apply a rule (R)" aria-label="Apply a rule (R)" aria-expanded={picker}>⊢ Apply rule</button>
              {picker && <RulePicker judgment={sel.node.judgment} unknowns={unknowns} onPick={apply} onClose={() => setPicker(false)} />}
            </div>
            <div className="btn-group">
              <button onClick={() => addPremise(sel.node.id)} title="Add premise above (P)" aria-label="Add premise above (P)">＋ Premise</button>
              <button onClick={() => extendBelow(sel.node.id)} title="Insert a new conclusion below (B)" aria-label="Insert a new conclusion below (B)">＋ Below</button>
            </div>
            <div className="btn-group">
              <button onClick={() => setEditing(sel.node.id)} title="Edit judgment (Enter)" aria-label="Edit judgment (Enter)">Edit</button>
              <button onClick={() => setEditingLabel(sel.node.id)} title="Rule name shown next to the line (N)" aria-label="Rule name shown next to the line (N)">Label</button>
              <button className={sel.node.leaf ? 'active' : ''} aria-pressed={!!sel.node.leaf} onClick={() => toggle(sel.node.id, 'leaf')} title="Mark as an assumption or side condition (no line, not an open goal)" aria-label="Mark as side condition">Leaf</button>
              <button className={sel.node.elided ? 'active' : ''} aria-pressed={!!sel.node.elided} onClick={() => toggle(sel.node.id, 'elided')} title="Elide the derivation above (⋮)" aria-label="Elide the derivation above">⋮</button>
            </div>
            <div className="btn-group">
              <button onClick={() => move(sel.node.id, -1)} disabled={!sel.parent} title="Move left" aria-label="Move left">←</button>
              <button onClick={() => move(sel.node.id, 1)} disabled={!sel.parent} title="Move right" aria-label="Move right">→</button>
              <button onClick={() => duplicate(sel.node.id)} disabled={!sel.parent} title="Duplicate subtree" aria-label="Duplicate subtree">⧉</button>
              <button className="danger" onClick={() => remove(sel.node.id)} title="Delete subtree (Del)" aria-label="Delete subtree (Del)">✕</button>
            </div>
          </>
        ) : (
          <span className="hint">Select a judgment to build the tree. <kbd>R</kbd> apply rule · <kbd>P</kbd> premise · <kbd>Enter</kbd> edit</span>
        )}
        <span className="grow" />
        <span className={'open-goals ' + (open ? 'some' : 'none')}>{open ? `${open} open goal${open > 1 ? 's' : ''}` : 'complete'}</span>
      </div>
      {notice && <div className="notice">{notice}</div>}
      {unknowns.length > 0 && (
        <div className="unknowns" onClick={(e) => e.stopPropagation()}>
          <span className="lbl">Unknowns</span>
          {unknowns.map((u) => <UnknownChip key={u} name={u} onSet={(v) => instantiateUnknown(u, v)} />)}
          <span className="dim">Applying more rules fills these in, or set one by hand.</span>
        </div>
      )}
      <div className="tree-canvas">
        <NodeView
          node={root}
          selected={selected}
          editing={editing}
          editingLabel={editingLabel}
          onSelect={(id) => { setSelected(id); setPicker(false); }}
          onFocusSelect={(id) => { setSelected(id); setPicker(false); }}
          onEdit={setEditing}
          onDoneEditing={() => { setEditing(null); box.current?.focus(); }}
          onDoneLabel={() => { setEditingLabel(null); box.current?.focus(); }}
          onEditLabel={setEditingLabel}
          setJudgment={(id, v) => mutate((r) => { const g = findNode(r, id); if (g) g.node.judgment = v; }, 'j' + id)}
          setLabel={(id, v) => mutate((r) => { const g = findNode(r, id); if (g) { g.node.rule = v || undefined; g.node.ruleRef = undefined; } }, 'l' + id)}
          addPremise={addPremise}
          isRoot
        />
      </div>
    </div>
  );
}

function UnknownChip({ name, onSet }: { name: string; onSet: (v: string) => void }) {
  const [v, setV] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <span className="unknown-chip">
      <span onClick={() => setOpen(!open)} title="Set this unknown"><Math tex={name} /> = ?</span>
      {open && (
        <span className="unknown-set">
          <MathField value={v} onChange={setV} startEditing placeholder="value" onDone={() => { if (v.trim()) { onSet(v); setOpen(false); } }} />
        </span>
      )}
    </span>
  );
}

interface NodeViewProps {
  node: ProofNode;
  selected: string | null;
  editing: string | null;
  editingLabel: string | null;
  onSelect: (id: string) => void;
  onFocusSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onEditLabel: (id: string) => void;
  onDoneEditing: () => void;
  onDoneLabel: () => void;
  setJudgment: (id: string, v: string) => void;
  setLabel: (id: string, v: string) => void;
  addPremise: (id: string) => void;
  isRoot?: boolean;
}

function NodeView(p: NodeViewProps) {
  const { node } = p;
  const isSel = p.selected === node.id;
  const noLine = node.children.length === 0 && (node.leaf || !node.rule) && !node.elided;
  const isOpen = node.children.length === 0 && !node.rule && !node.leaf && !node.elided;
  const concl = (
    <div
      className={'pt-concl' + (isSel ? ' sel' : '') + (isOpen ? ' open' : '')}
      tabIndex={p.editing === node.id ? -1 : 0}
      role="button"
      aria-pressed={isSel}
      aria-label={(node.judgment || 'empty judgment') + (node.rule ? ` by ${node.rule}` : '') + (isOpen ? ', open goal' : '')}
      onFocus={() => { if (!isSel) p.onFocusSelect(node.id); }}
      onClick={(e) => { e.stopPropagation(); p.onSelect(node.id); }}
      onDoubleClick={(e) => { e.stopPropagation(); p.onEdit(node.id); }}
    >
      {p.editing === node.id ? (
        <MathField
          value={node.judgment}
          onChange={(v) => p.setJudgment(node.id, v)}
          startEditing
          onDone={p.onDoneEditing}
          placeholder="judgment, e.g. \Gamma \vdash e : \tau"
        />
      ) : node.judgment.trim() ? (
        <Math tex={node.judgment} />
      ) : (
        <span className="placeholder">empty judgment</span>
      )}
    </div>
  );
  const label = p.editingLabel === node.id ? (
    <input
      className="pt-label-input"
      autoFocus
      value={node.rule ?? ''}
      placeholder="Rule"
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => p.setLabel(node.id, e.target.value)}
      onBlur={p.onDoneLabel}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } e.stopPropagation(); }}
    />
  ) : (
    <span className="pt-label" onClick={(e) => { e.stopPropagation(); p.onSelect(node.id); }} onDoubleClick={(e) => { e.stopPropagation(); p.onEditLabel(node.id); }}>
      {node.rule}
    </span>
  );

  if (noLine && !(p.editingLabel === node.id)) {
    return <div className={'pt-node leaf' + (node.leaf ? ' assumption' : '')}>{concl}</div>;
  }
  return (
    <div className={'pt-node' + (isSel ? ' selnode' : '')}>
      <div className="pt-prem">
        {node.elided ? (
          <div className="pt-vdots"><Math tex="\vdots" /></div>
        ) : (
          node.children.map((c) => <NodeView key={c.id} {...p} node={c} isRoot={false} />)
        )}
        {isSel && !node.elided && (
          <button className="pt-add" title="Add premise" aria-label="Add premise" onClick={(e) => { e.stopPropagation(); p.addPremise(node.id); }}>＋</button>
        )}
      </div>
      <div className={'pt-line' + (node.elided ? ' none' : '')} />
      {label}
      {concl}
    </div>
  );
}

function RulePicker({ judgment, unknowns, onPick, onClose }: { judgment: string; unknowns: string[]; onPick: (r: Rule) => void; onClose: () => void }) {
  const doc = useStore((s) => s.doc);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const macros = useMemo(() => docMacros(doc), [doc.snippets]); // eslint-disable-line
  const rules = useMemo(() => {
    const rs = allRules(doc).map(({ rule, group }) => ({
      rule,
      group,
      match: judgment.trim() ? !!matchJudgment(rule.conclusion, judgment, macros, unknowns) : null,
    }));
    rs.sort((a, b) => Number(!!b.match) - Number(!!a.match));
    return rs;
  }, [doc, judgment, macros, unknowns]);
  const shown = rules.filter((r) => r.rule.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="rule-picker" onClick={(e) => e.stopPropagation()}>
      <input
        autoFocus
        placeholder="Search rules…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math2.min(hi + 1, shown.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math2.max(hi - 1, 0)); }
          if (e.key === 'Enter' && shown[hi]) { e.preventDefault(); onPick(shown[hi].rule); }
          if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          e.stopPropagation();
        }}
      />
      <div className="rule-list">
        {shown.length === 0 && <div className="empty">No rules yet. Add a "Rules" block to define inference rules.</div>}
        {shown.map((r, i) => (
          <div
            key={r.rule.id}
            className={'rule-item' + (i === hi ? ' hi' : '') + (r.match === false ? ' nomatch' : '')}
            onMouseEnter={() => setHi(i)}
            onClick={() => onPick(r.rule)}
          >
            <div className="rule-item-head">
              <span className="rulename">{r.rule.name || '(unnamed)'}</span>
              {r.match === true && <span className="badge ok">matches</span>}
              <span className="group">{r.group}</span>
            </div>
            <RuleView rule={r.rule} small />
          </div>
        ))}
      </div>
    </div>
  );
}

const Math2 = globalThis.Math;

export function RuleView({ rule, small }: { rule: Rule; small?: boolean }) {
  const prem = rule.premises.filter((x) => x.trim());
  return (
    <div className={'pt-node rule-view' + (small ? ' small' : '')}>
      <div className="pt-prem">
        {prem.map((x, i) => <div key={i} className="pt-concl"><Math tex={x} /></div>)}
      </div>
      <div className="pt-line" />
      <span className="pt-label">{rule.name}{rule.side?.trim() && <span className="side"> <Math tex={rule.side} /></span>}</span>
      <div className="pt-concl"><Math tex={rule.conclusion} /></div>
    </div>
  );
}
