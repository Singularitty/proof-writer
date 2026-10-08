import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { renderTex, useMacros } from './Math';
import { numbering } from './ProseView';

export interface Suggestion {
  label: string; // shown
  insert: string; // replaces the typed prefix
  caretBack?: number; // move caret this many chars back from the end of the inserted text
  preview?: string; // TeX to render
  detail?: string;
}

// [name, arity, preview]
export const COMMON_COMMANDS: [string, number, string?][] = [
  ['vdash', 0], ['Vdash', 0], ['vDash', 0], ['models', 0], ['dashv', 0],
  ['to', 0], ['rightarrow', 0], ['Rightarrow', 0], ['longrightarrow', 0], ['Longrightarrow', 0],
  ['mapsto', 0], ['leadsto', 0], ['Downarrow', 0], ['Uparrow', 0], ['hookrightarrow', 0], ['rightharpoonup', 0],
  ['Gamma', 0], ['Delta', 0], ['Sigma', 0], ['Theta', 0], ['Phi', 0], ['Psi', 0], ['Omega', 0], ['Pi', 0],
  ['alpha', 0], ['beta', 0], ['gamma', 0], ['delta', 0], ['epsilon', 0], ['kappa', 0], ['lambda', 0], ['Lambda', 0],
  ['mu', 0], ['pi', 0], ['rho', 0], ['sigma', 0], ['tau', 0], ['phi', 0], ['psi', 0], ['omega', 0], ['theta', 0], ['iota', 0], ['ell', 0],
  ['forall', 0], ['exists', 0], ['in', 0], ['notin', 0], ['ni', 0], ['subseteq', 0], ['subset', 0], ['supseteq', 0],
  ['cup', 0], ['cap', 0], ['setminus', 0], ['emptyset', 0], ['varnothing', 0], ['uplus', 0],
  ['cdot', 0], ['times', 0], ['circ', 0], ['oplus', 0], ['otimes', 0], ['star', 0], ['bullet', 0],
  ['langle', 0], ['rangle', 0], ['llbracket', 0], ['rrbracket', 0], ['lfloor', 0], ['rfloor', 0], ['mid', 0], ['|', 0],
  ['equiv', 0], ['leq', 0], ['geq', 0], ['neq', 0], ['approx', 0], ['sim', 0], ['simeq', 0], ['cong', 0],
  ['sqsubseteq', 0], ['sqcup', 0], ['sqcap', 0], ['prec', 0], ['preceq', 0], ['triangleq', 0], ['coloneqq', 0],
  ['top', 0], ['bot', 0], ['wedge', 0], ['vee', 0], ['neg', 0], ['land', 0], ['lor', 0], ['implies', 0], ['iff', 0],
  ['ldots', 0], ['cdots', 0], ['vdots', 0], ['quad', 0], ['qquad', 0],
  ['mathsf', 1], ['mathit', 1], ['mathrm', 1], ['mathtt', 1], ['mathbf', 1], ['mathcal', 1], ['mathbb', 1], ['text', 1],
  ['textsc', 1], ['operatorname', 1], ['overline', 1], ['underline', 1], ['hat', 1], ['bar', 1], ['tilde', 1], ['vec', 1], ['dot', 1],
  ['frac', 2], ['overset', 2], ['underset', 2], ['sqrt', 1], ['boxed', 1],
];

const ARG_SAMPLE = ['x', 'y', 'z', 'w', 'u', 'v', 'a', 'b', 'c'];

export function mathSuggestions(prefix: string, snippets: { name: string; arity: number; body: string; kind: string; description?: string }[]): Suggestion[] {
  const out: Suggestion[] = [];
  const p = prefix.toLowerCase();
  for (const s of snippets) {
    if (s.kind !== 'math' || !s.name.toLowerCase().startsWith(p)) continue;
    const args = '{}'.repeat(s.arity);
    out.push({
      label: '\\' + s.name + (s.arity ? `{…}`.repeat(s.arity) : ''),
      insert: '\\' + s.name + args,
      caretBack: s.arity ? args.length - 1 : 0,
      preview: '\\' + s.name + ARG_SAMPLE.slice(0, s.arity).map((a) => `{${a}}`).join(''),
      detail: s.description || 'snippet',
    });
  }
  for (const [name, arity] of COMMON_COMMANDS) {
    if (!name.toLowerCase().startsWith(p)) continue;
    const args = '{}'.repeat(arity);
    out.push({
      label: '\\' + name,
      insert: '\\' + name + args + (arity === 0 && /^[A-Za-z]/.test(name) ? ' ' : ''),
      caretBack: arity ? args.length - 1 : 0,
      preview: '\\' + name + ARG_SAMPLE.slice(0, arity).map((a) => `{${a}}`).join(''),
    });
  }
  return out.slice(0, 12);
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  kind: 'math' | 'prose';
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  onBlur?: () => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Enter commits (calls onBlur) instead of inserting a newline. */
  singleLine?: boolean;
  minRows?: number;
}

export interface SmartTextareaHandle { focus: () => void; insert: (s: string) => void }

export const SmartTextarea = forwardRef<SmartTextareaHandle, Props>(function SmartTextarea(props, ref) {
  const { value, onChange, kind, placeholder, autoFocus, className, onBlur, singleLine, minRows } = props;
  const ta = useRef<HTMLTextAreaElement>(null);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [sel, setSel] = useState(0);
  const [prefixLen, setPrefixLen] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const snippets = useStore((s) => s.doc.snippets);
  const doc = useStore((s) => s.doc);
  const setInsertTarget = useStore((s) => s.setInsertTarget);
  const macros = useMacros();

  const insertText = (text: string, replaceBefore = 0, caretBack = 0) => {
    const el = ta.current;
    if (!el) return;
    const start = el.selectionStart - replaceBefore;
    const end = el.selectionEnd;
    const next = value.slice(0, start) + text + value.slice(end);
    pendingCaret.current = start + text.length - caretBack;
    onChange(next);
  };

  useImperativeHandle(ref, () => ({
    focus: () => ta.current?.focus(),
    insert: (s: string) => insertText(s),
  }));

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = el.scrollHeight + 2 + 'px';
    if (pendingCaret.current !== null) {
      el.selectionStart = el.selectionEnd = pendingCaret.current;
      pendingCaret.current = null;
    }
  }, [value]);

  useEffect(() => {
    if (autoFocus) {
      const el = ta.current;
      el?.focus();
      if (el) el.selectionStart = el.selectionEnd = el.value.length;
    }
  }, [autoFocus]);

  const refSuggestions = useMemo(() => {
    const num = numbering(doc);
    const out: Suggestion[] = [];
    for (const [label, name] of num.labels) out.push({ label: `[[${label}]]`, insert: `[[${label}]]`, detail: name });
    for (const r of num.rules) out.push({ label: `[[${r}]]`, insert: `[[${r}]]`, detail: 'rule' });
    return out;
  }, [doc]);

  const recompute = () => {
    const el = ta.current;
    if (!el || el.selectionStart !== el.selectionEnd) { setSugs([]); return; }
    const before = el.value.slice(0, el.selectionStart);
    let m: RegExpExecArray | null;
    let list: Suggestion[] = [];
    let plen = 0;
    if (kind === 'prose' && (m = /\[\[([^\]\n]*)$/.exec(before))) {
      const q = m[1].toLowerCase();
      list = refSuggestions.filter((s) => s.insert.toLowerCase().includes(q)).slice(0, 12);
      plen = m[0].length;
    } else if (kind === 'prose' && (m = /\{\{([\w-]*)$/.exec(before))) {
      const q = m[1].toLowerCase();
      list = snippets
        .filter((s) => s.kind === 'text' && s.name.toLowerCase().startsWith(q))
        .map((s) => ({ label: `{{${s.name}}}`, insert: `{{${s.name}}}`, detail: s.body.slice(0, 40) }));
      plen = m[0].length;
    } else if ((m = /\\([A-Za-z]+)$/.exec(before))) {
      if (kind === 'prose' && !insideMath(before)) { setSugs([]); return; }
      list = mathSuggestions(m[1], snippets);
      plen = m[0].length;
    }
    setSugs(list);
    setSel(0);
    setPrefixLen(plen);
  };

  const accept = (s: Suggestion) => {
    insertText(s.insert, prefixLen, s.caretBack ?? 0);
    setSugs([]);
  };

  return (
    <div className={'smart ' + (className ?? '')}>
      <textarea
        ref={ta}
        value={value}
        rows={minRows ?? 1}
        spellCheck={kind === 'prose'}
        placeholder={placeholder}
        className={kind === 'math' ? 'mono' : ''}
        onChange={(e) => { onChange(e.target.value); requestAnimationFrame(recompute); }}
        onFocus={() => setInsertTarget({ kind, insert: (s) => insertText(s) })}
        onBlur={() => { setTimeout(() => setSugs([]), 150); onBlur?.(); }}
        onKeyDown={(e) => {
          if (sugs.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((sel + 1) % sugs.length); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((sel - 1 + sugs.length) % sugs.length); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(sugs[sel]); return; }
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSugs([]); return; }
          }
          if (singleLine && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.current?.blur(); return; }
          if (e.key === 'Escape') { e.preventDefault(); ta.current?.blur(); return; }
          props.onKeyDown?.(e);
        }}
        onKeyUp={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') recompute(); }}
        onClick={recompute}
      />
      {sugs.length > 0 && (
        <ul className="ac-list" onMouseDown={(e) => e.preventDefault()}>
          {sugs.map((s, i) => (
            <li key={s.label + i} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => accept(s)}>
              <span className="ac-label mono">{s.label}</span>
              {s.preview && <span className="ac-prev" dangerouslySetInnerHTML={{ __html: renderTex(s.preview, macros) }} />}
              {s.detail && <span className="ac-detail">{s.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

function insideMath(before: string): boolean {
  let n = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '\\') { i++; continue; }
    if (before[i] === '$') n++;
  }
  return n % 2 === 1;
}
