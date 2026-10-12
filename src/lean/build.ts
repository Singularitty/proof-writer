// Reading what a build left behind: Lake's diagnostics, the marker comments
// that tie Lean declarations to blocks of the document, and whether a file
// still holds a `sorry` or declares an axiom. Plain text in, plain data out.

import type { Id } from '../model/types';

export interface Diagnostic {
  /** Relative to the Lean folder, with forward slashes: PW/Defs.lean. */
  file: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** `PW/Defs.lean` from however Lake wrote the path. */
function leanPath(p: string): string {
  const q = p.replace(/\\/g, '/');
  const at = q.lastIndexOf('/PW/');
  return at >= 0 ? q.slice(at + 1) : q.replace(/^(\.\/)+/, '');
}

// Lake 4.9 and later put the severity first; before that, Lean's own order showed through.
const SEVERITY_FIRST = /^(error|warning|info): (.+?\.lean):(\d+):(\d+): (.*)$/;
const PATH_FIRST = /^(.+?\.lean):(\d+):(\d+): (error|warning|info): (.*)$/;
/** Lines of Lake's own that end a diagnostic's message. */
const LAKE_LINE = /^(✖|✔|⚠|ℹ|trace: |error: |warning: |info: |Some required builds|Build completed|- PW)/;

export function parseBuild(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  let open: Diagnostic | null = null;
  for (const line of output.split(/\r?\n/)) {
    const a = SEVERITY_FIRST.exec(line);
    const b = a ? null : PATH_FIRST.exec(line);
    if (a) open = { severity: a[1] as Diagnostic['severity'], file: leanPath(a[2]), line: +a[3], column: +a[4], message: a[5] };
    else if (b) open = { severity: b[4] as Diagnostic['severity'], file: leanPath(b[1]), line: +b[2], column: +b[3], message: b[5] };
    else {
      if (open && !LAKE_LINE.test(line) && line.trim() !== '') open.message += '\n' + line;
      else open = null;
      continue;
    }
    out.push(open);
  }
  return out;
}

export interface Marker { line: number; block: Id; rule?: Id }

const MARKER = /^\s*--\s*pw:\s*(\S+)(?:\s+(\S+))?\s*$/;

/** The `-- pw: <block> [<rule>]` comments of a Lean file, with 1-based lines. */
export function markers(text: string): Marker[] {
  const out: Marker[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const m = MARKER.exec(line);
    if (m) out.push(m[2] ? { line: i + 1, block: m[1], rule: m[2] } : { line: i + 1, block: m[1] });
  });
  return out;
}

/** A `'` that starts a char literal: `'x'`, `'"'`, `'\n'`, `'\''`, `'\x41'`, `'\u{1F600}'`. */
const CHAR = /'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|.)|[^\\\n'])'/uy;
/** An `r` that opens a raw string: `r"` or `r#"` with any number of `#`. */
const RAW = /r(#*)"/y;
/** Characters that make a following `'` or `r` part of an identifier. */
const IDENT = /[\w']/;

/** The file with comments and string and char literal contents blanked, line breaks kept. */
function codeOnly(text: string): string {
  let out = '';
  let depth = 0;
  let i = 0;
  const blank = (c: string) => (c === '\n' ? '\n' : ' ');
  const fresh = (at: number) => at === 0 || !IDENT.test(text[at - 1]);
  while (i < text.length) {
    if (text.startsWith('/-', i)) { depth++; out += '  '; i += 2; continue; }
    if (depth > 0) {
      if (text.startsWith('-/', i)) { depth--; out += '  '; i += 2; } else out += blank(text[i++]);
      continue;
    }
    if (text.startsWith('--', i)) {
      while (i < text.length && text[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (text[i] === 'r' && fresh(i)) {
      RAW.lastIndex = i;
      const m = RAW.exec(text);
      if (m) {
        const close = '"' + m[1];
        const end = text.indexOf(close, i + m[0].length);
        const stop = end < 0 ? text.length : end + close.length;
        while (i < stop) out += blank(text[i++]);
        continue;
      }
    }
    if (text[i] === '"') {
      out += ' ';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) { out += ' '; i++; }
        out += blank(text[i++]);
      }
      out += ' ';
      i++;
      continue;
    }
    if (text[i] === "'" && fresh(i)) {
      CHAR.lastIndex = i;
      const m = CHAR.exec(text);
      if (m) { out += ' '.repeat(m[0].length); i += m[0].length; continue; }
    }
    out += text[i++];
  }
  return out;
}

export interface Scan { sorries: number[]; axioms: { line: number; name: string }[] }

const SORRY = /(?<![\w.])(sorryAx|sorry|admit)(?![\w])/;
const AXIOM = /(?<![\w.])axiom(?![\w'])/g;
/** The name on the same line as `axiom`, then the name on the next non-blank line. */
const NAME = /^[ \t]*([^\s:({\[]+)/;
const NEXT = /^\s*([^\s:({\[]+)/;

/** Lines (1-based) holding `sorry`, `admit` or `sorryAx`, and the axioms declared, outside comments and literals. */
export function scan(text: string): Scan {
  const code = codeOnly(text);
  const out: Scan = { sorries: [], axioms: [] };
  code.split(/\r?\n/).forEach((line, i) => {
    if (SORRY.test(line)) out.sorries.push(i + 1);
  });
  for (const m of code.matchAll(AXIOM)) {
    const at = m.index!;
    const line = code.slice(0, at).split('\n').length;
    const rest = code.slice(at + 'axiom'.length);
    const named = NAME.exec(rest) ?? NEXT.exec(rest);
    out.axioms.push({ line, name: named ? named[1] : '(unnamed)' });
  }
  return out;
}
