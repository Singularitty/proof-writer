// Imports a Typst document into the block model: headings become (sections of)
// headings, curryst `rule`/`prooftree` calls become rule blocks or proof trees,
// `x ::= a | b` displays become grammar blocks, and everything else becomes prose,
// with math converted to the app's LaTeX syntax. Anything that has no equivalent
// is kept as a raw Typst block and reported in `warnings`.

import type { Block, Doc, GrammarProduction, ProofNode, Rule, TheoremKind } from '../model/types';
import { emptyDoc } from '../model/sample';
import { uid } from '../model/util';
import { splitTopLevel, typstMathToTex } from './typstMath';

export interface ImportResult { doc: Doc; warnings: string[] }

type Item =
  | { k: 'heading'; level: number; text: string }
  | { k: 'comment'; lines: string[] }
  | { k: 'code'; src: string }
  | { k: 'para'; src: string };

// ---------- scanning ----------

/** Index just past the bracket matching the one at `i` (`(`, `[` or `{`), skipping strings, math and comments. */
function matchBracket(s: string, i: number): number {
  const open = s[i];
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '"' && open !== '[') { j = skipString(s, j); continue; }
    if (c === '$') { j = skipMath(s, j); continue; }
    if (c === '/' && s[j + 1] === '/') { while (j < s.length && s[j] !== '\n') j++; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j + 1; }
    else if (c === '(' || c === '[' || c === '{') { j = matchBracket(s, j) - 1; }
  }
  return s.length;
}

function skipString(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') return j;
  }
  return s.length;
}

/** Index of the `$` closing the math started at `i`. */
function skipMath(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '"') { j = skipString(s, j); continue; }
    if (s[j] === '$') return j;
  }
  return s.length;
}

function scan(src: string): Item[] {
  src = src.replace(/\r\n?/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const items: Item[] = [];
  let i = 0;
  let para = '';
  const flush = () => { if (para.trim()) items.push({ k: 'para', src: para.trim() }); para = ''; };
  while (i < src.length) {
    const lineEnd = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    const line = src.slice(i, lineEnd);
    const trimmed = line.trim();
    const h = /^(=+)\s+(.*)$/.exec(trimmed);
    if (h && line.startsWith('=')) {
      flush();
      items.push({ k: 'heading', level: h[1].length, text: h[2].replace(/\s*<[\w:.-]+>\s*$/, '') });
      i = lineEnd + 1;
      continue;
    }
    if (trimmed.startsWith('//')) {
      flush();
      const last = items[items.length - 1];
      if (last?.k === 'comment') last.lines.push(trimmed); else items.push({ k: 'comment', lines: [trimmed] });
      i = lineEnd + 1;
      continue;
    }
    if (trimmed === '') { flush(); i = lineEnd + 1; continue; }
    if (trimmed.startsWith('#') && para.trim() === '') {
      // A code expression: #name, then any (args) and [content] that follow directly.
      const start = i + line.indexOf('#');
      let j = start + 1;
      while (j < src.length && /[\w.-]/.test(src[j])) j++;
      // Statements (#import, #set, #show, #let) run to the end of the line.
      if (/^#(import|include|set|show|let)$/.test(src.slice(start, j))) j = lineEnd;
      while (src[j] === '(' || src[j] === '[') j = matchBracket(src, j);
      items.push({ k: 'code', src: src.slice(start, j) });
      i = j;
      // skip the rest of the line if it is only whitespace
      const rest = src.slice(i, src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i));
      if (!rest.trim()) i += rest.length + 1;
      continue;
    }
    // Paragraph text; display math may span lines (even blank ones).
    let j = i;
    for (; j < lineEnd; j++) {
      if (src[j] === '\\') { j++; continue; }
      if (src[j] === '$') j = skipMath(src, j);
    }
    para += src.slice(i, Math.max(j, lineEnd)) + '\n';
    i = Math.max(j, lineEnd) + 1;
  }
  flush();
  return items;
}

// ---------- prose ----------

type Seg = { k: 'text'; v: string } | { k: 'display'; v: string };

function splitPara(src: string): Seg[] {
  const segs: Seg[] = [];
  let text = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { text += src.slice(i, i + 2); i++; continue; }
    if (c === '$') {
      const end = skipMath(src, i);
      const body = src.slice(i + 1, end);
      if (body.length > 0 && /^\s/.test(body) && /\s$/.test(body)) {
        if (text.trim()) segs.push({ k: 'text', v: text });
        text = '';
        segs.push({ k: 'display', v: body.trim() });
      } else {
        text += src.slice(i, end + 1);
      }
      i = end;
      continue;
    }
    text += c;
  }
  if (text.trim()) segs.push({ k: 'text', v: text });
  return segs;
}

class Importer {
  warnings: string[] = [];
  where = '';

  math(src: string): string {
    const r = typstMathToTex(src);
    for (const w of r.warnings) this.warn(w);
    return r.tex;
  }

  warn(msg: string) {
    const full = this.where ? `${this.where}: ${msg}` : msg;
    if (!this.warnings.includes(full)) this.warnings.push(full);
  }

  /** Typst markup (without display math) → the app's prose syntax. */
  prose(src: string): string {
    const lines = src.split('\n').map((l) => l.trim()).filter((l, i, a) => l || (i > 0 && i < a.length - 1));
    let out = '';
    for (const l of lines) {
      const list = /^([-+])\s+(.*)$/.exec(l);
      if (list) out += (out ? '\n' : '') + (list[1] === '-' ? '- ' : '1. ') + this.inline(list[2]);
      else if (/^(- |1\. )/.test(out.split('\n').pop() ?? '') ) out += '\n' + this.inline(l);
      else out += (out ? ' ' : '') + this.inline(l);
    }
    return out.trim();
  }

  inline(s: string): string {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') {
        const n = s[i + 1] ?? '';
        if (n === '\\' || n === '') { out += '\n'; } else out += n === '*' || n === '$' ? '\\' + n : n;
        i++;
        continue;
      }
      if (c === '$') {
        const end = skipMath(s, i);
        const body = s.slice(i + 1, end);
        out += body.trim() ? `$${this.math(body)}$` : '';
        i = end;
        continue;
      }
      if (c === '*') {
        const end = s.indexOf('*', i + 1);
        if (end > i) { out += `**${this.inline(s.slice(i + 1, end)).trim()}**`; i = end; continue; }
      }
      if (c === '_' && (i === 0 || /[\s(]/.test(s[i - 1]))) {
        const end = s.indexOf('_', i + 1);
        if (end > i + 1) { out += `*${this.inline(s.slice(i + 1, end)).trim()}*`; i = end; continue; }
      }
      if (c === '@' && /[\w]/.test(s[i + 1] ?? '') && (i === 0 || /\s|\(/.test(s[i - 1]))) {
        const m = /^@([\w:.-]*\w)/.exec(s.slice(i));
        if (m) { out += `[[${m[1]}]]`; i += m[0].length - 1; continue; }
      }
      if (c === '#') {
        this.warn(`inline code "${s.slice(i, i + 30)}…" kept as text`);
      }
      out += c;
    }
    return out;
  }

  // ---------- grammar ----------

  grammarRow(src: string, category: string): GrammarProduction | null {
    const parts = splitTopLevel(src, '::=');
    if (parts.length !== 2) return null;
    const rhs = parts[1].replace(/\\(?=\s|$)/g, ' ').replace(/&/g, ' ');
    const alts = splitTopLevel(rhs, '|').map((a) => a.trim()).filter(Boolean);
    return {
      id: uid(),
      category,
      metavar: this.math(parts[0].replace(/&/g, ' ').trim()),
      alternatives: alts.map((a) => this.math(a)),
    };
  }

  // ---------- rules ----------

  /** Top-level arguments of a call whose argument text is `inner` (without the parens). */
  args(inner: string): { name?: string; v: string }[] {
    const out: { name?: string; v: string }[] = [];
    let start = 0;
    const push = (end: number) => {
      const raw = inner.slice(start, end).trim();
      if (!raw) return;
      const m = /^([a-z][\w-]*)\s*:\s*([\s\S]*)$/.exec(raw);
      if (m && !raw.startsWith('$') && !raw.startsWith('[')) out.push({ name: m[1], v: m[2].trim() });
      else out.push({ v: raw });
    };
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '"') { i = skipString(inner, i); continue; }
      if (c === '$') { i = skipMath(inner, i); continue; }
      if (c === '(' || c === '[' || c === '{') { i = matchBracket(inner, i) - 1; continue; }
      if (c === ',') { push(i); start = i + 1; }
    }
    push(inner.length);
    return out;
  }

  /** A rule argument: math, content holding math, or a nested rule. */
  ruleArg(v: string): { kind: 'math'; tex: string } | { kind: 'rule'; node: ProofNode } | { kind: 'empty' } {
    v = v.trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).trim();
    if (v.startsWith('#')) v = v.slice(1);
    if (v === '' || v === '$$') return { kind: 'empty' };
    if (/^rule\s*\(/.test(v)) {
      const node = this.ruleNode(v);
      return node ? { kind: 'rule', node } : { kind: 'empty' };
    }
    if (v.startsWith('$') && skipMath(v, 0) === v.length - 1) {
      const body = v.slice(1, -1).trim();
      return body ? { kind: 'math', tex: this.math(body) } : { kind: 'empty' };
    }
    this.warn(`rule argument "${v.slice(0, 40)}" is not math, kept as text`);
    return { kind: 'math', tex: `\\text{${v.replace(/[{}\\$]/g, '')}}` };
  }

  ruleName(v: string | undefined): string {
    if (!v) return '';
    v = v.trim();
    if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1).trim();
    if (v.startsWith('$') && v.endsWith('$')) v = v.slice(1, -1).trim();
    const str = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
    if (str) return str[1];
    return v.replace(/["$]/g, '').trim();
  }

  /** Parses `rule(...)` into a proof node (premises as children). */
  ruleNode(call: string): ProofNode | null {
    const open = call.indexOf('(');
    const end = matchBracket(call, open);
    const args = this.args(call.slice(open + 1, end - 1));
    const named = new Map(args.filter((a) => a.name).map((a) => [a.name!, a.v]));
    const pos = args.filter((a) => !a.name).map((a) => this.ruleArg(a.v));
    const concl = pos.pop();
    if (!concl || concl.kind !== 'math') { this.warn('a rule without a conclusion was skipped'); return null; }
    const children: ProofNode[] = [];
    for (const p of pos) {
      if (p.kind === 'math') children.push({ id: uid(), judgment: p.tex, children: [], leaf: true });
      else if (p.kind === 'rule') children.push(p.node);
    }
    return { id: uid(), judgment: concl.tex, rule: this.ruleName(named.get('name') ?? named.get('label')), children };
  }

  /** Finds every prooftree(...) / rule-set(...) in a code expression. */
  trees(code: string): ProofNode[] {
    const out: ProofNode[] = [];
    const re = /(?:^|[^\w-])(prooftree|rule-set)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code))) {
      const open = code.indexOf('(', m.index + m[0].length - 1);
      const end = matchBracket(code, open);
      for (const a of this.args(code.slice(open + 1, end - 1))) {
        if (a.name) continue;
        const v = a.v.replace(/^#/, '');
        if (/^rule\s*\(/.test(v)) { const n = this.ruleNode(v); if (n) out.push(n); }
      }
      re.lastIndex = end;
    }
    if (!out.length && /^#rule\s*\(/.test(code)) { const n = this.ruleNode(code.slice(1)); if (n) out.push(n); }
    return out;
  }
}

function isFlat(n: ProofNode): boolean {
  return n.children.every((c) => c.children.length === 0);
}

function toRule(n: ProofNode): Rule {
  return { id: uid(), name: n.rule ?? '', premises: n.children.map((c) => c.judgment), conclusion: n.judgment };
}

const THEOREM_RE = /^(Lemma|Theorem|Corollary|Proposition|Definition|Conjecture)\b\s*([\d.]*)\s*[-–—:.]?\s*(.*)$/i;

export function importTypst(src: string): ImportResult {
  const im = new Importer();
  const items = scan(src);
  const doc = emptyDoc();
  doc.blocks = [];
  doc.title = '';
  const blocks = doc.blocks;
  let pendingJudgment: string | undefined;
  let heading = '';

  const lastBlock = () => blocks[blocks.length - 1];
  const addText = (text: string) => {
    if (!text) return;
    const last = lastBlock();
    if (last?.type === 'text') last.text += '\n\n' + text;
    else blocks.push({ id: uid(), type: 'text', text });
  };

  // The first level-1 heading with nothing under it is the document title.
  const firstH1 = items.findIndex((it) => it.k === 'heading');
  if (firstH1 >= 0) {
    const it = items[firstH1] as Extract<Item, { k: 'heading' }>;
    const next = items[firstH1 + 1];
    if (it.level === 1 && (!next || (next.k === 'heading' && next.level === 1))) {
      doc.title = it.text;
      items.splice(firstH1, 1);
    }
  }

  for (let idx = 0; idx < items.length; idx++) {
    const it = items[idx];
    im.where = heading ? `"${heading}"` : '';
    switch (it.k) {
      case 'heading': {
        heading = it.text;
        if (it.level > 3) im.warn(`heading level ${it.level} shown as level 3`);
        blocks.push({ id: uid(), type: 'heading', level: Math.min(3, it.level) as 1 | 2 | 3, text: it.text });
        break;
      }
      case 'comment': {
        // Comments stay invisible in the output but are kept in a raw block.
        blocks.push({
          id: uid(), type: 'raw',
          typst: it.lines.join('\n'),
          latex: it.lines.map((l) => '%' + l.replace(/^\/\//, '')).join('\n'),
        });
        break;
      }
      case 'code': {
        const name = /^#([\w.-]+)/.exec(it.src)?.[1] ?? '';
        if (name === 'import' || name === 'include') {
          if (!/curryst/.test(it.src)) im.warn(`${it.src.split('\n')[0]} dropped`);
          break;
        }
        if (name === 'pagebreak') { blocks.push({ id: uid(), type: 'raw', typst: '#pagebreak()', latex: '\\clearpage' }); break; }
        const trees = /prooftree|rule-set|^#rule\(/.test(it.src) ? im.trees(it.src) : [];
        if (trees.length) {
          for (const t of trees) {
            if (isFlat(t)) {
              const last = lastBlock();
              if (last?.type === 'rules' && !pendingJudgment) last.rules.push(toRule(t));
              else blocks.push({ id: uid(), type: 'rules', title: '', judgment: pendingJudgment ?? '', rules: [toRule(t)] });
              pendingJudgment = undefined;
            } else {
              blocks.push({ id: uid(), type: 'derivation', caption: '', root: t });
            }
          }
          break;
        }
        // #box(stroke: …, [$ judgment $]) right before rules is a judgment form.
        const boxed = /^#(?:box|rect)\([\s\S]*\[\s*\$([\s\S]*)\$\s*\]\s*\)$/.exec(it.src);
        if (boxed) {
          const next = items.slice(idx + 1).find((x) => x.k !== 'comment');
          if (next?.k === 'code' && /prooftree|rule-set/.test(next.src)) { pendingJudgment = im.math(boxed[1].trim()); break; }
        }
        im.warn(`${it.src.split('\n')[0].slice(0, 50)} has no editor equivalent; kept as raw Typst`);
        blocks.push({ id: uid(), type: 'raw', typst: it.src, latex: '% Typst-only content: ' + it.src.split('\n')[0] });
        break;
      }
      case 'para': {
        const segs = splitPara(it.src);
        // "Lemma 1.1 - Name" on its own line starts a theorem block.
        if (segs.length === 1 && segs[0].k === 'text' && !segs[0].v.trim().includes('\n')) {
          const m = THEOREM_RE.exec(segs[0].v.trim());
          if (m) {
            blocks.push({
              id: uid(), type: 'theorem', kind: m[1].toLowerCase() as TheoremKind,
              title: im.inline(m[3]), label: '', statement: '', proof: [],
            });
            // a following lone "$ square $" is the QED mark, which the proof already prints
            const nx = items[idx + 1];
            if (nx?.k === 'para' && /^\$\s*(square|qed|square\.stroked)\s*\$$/.test(nx.src.trim())) idx++;
            break;
          }
        }
        let text = '';
        const flushText = () => { if (text.trim()) addText(text.trim()); text = ''; };
        segs.forEach((seg, si) => {
          if (seg.k === 'text') { text += (text ? '\n\n' : '') + im.prose(seg.v); return; }
          if (splitTopLevel(seg.v, '::=').length === 2) {
            // A short label right before it (e.g. "*Runtime values*") names the category.
            let category = '';
            const prevSeg = segs[si - 1];
            const label = (s: string) => {
              const t = s.trim();
              const bold = /^\*\s*([^*\n]+?)\s*\*$/.exec(t);
              if (bold) return bold[1];
              return t.length <= 40 && !/[.:;$]$/.test(t) && !t.includes('\n') && !t.includes('$') ? t : '';
            };
            if (prevSeg?.k === 'text' && label(prevSeg.v) && text.trim() === im.prose(prevSeg.v)) {
              category = label(prevSeg.v);
              text = '';
            } else if (si === 0) {
              // label in the previous paragraph
              const last = lastBlock();
              if (last?.type === 'text') {
                const paras = last.text.split('\n\n');
                const tail = paras[paras.length - 1];
                const b = /^\*\*([^*]+)\*\*$/.exec(tail.trim());
                if (b) {
                  category = b[1];
                  paras.pop();
                  if (paras.length) last.text = paras.join('\n\n'); else blocks.pop();
                }
              }
            }
            flushText();
            const row = im.grammarRow(seg.v, category);
            if (row) {
              const last = lastBlock();
              if (last?.type === 'grammar') last.rows.push(row);
              else blocks.push({ id: uid(), type: 'grammar', title: '', rows: [row] });
              return;
            }
          }
          text += (text ? '\n\n' : '') + `$$${im.math(seg.v)}$$`;
        });
        flushText();
        break;
      }
    }
  }
  // Drop a trailing empty proof list on theorems so the editor shows an empty proof.
  for (const b of blocks) if (b.type === 'theorem' && b.proof && !b.proof.length) b.proof = [{ id: uid(), type: 'text', text: '' }];
  if (!doc.title) doc.title = 'Imported document';
  return { doc, warnings: im.warnings };
}

export type { Block };
