import type { Doc, Snippet } from './types';

/** How many times a snippet is called anywhere in the document, other snippets' bodies included. */
export function snippetUses(doc: Doc, s: Snippet): number {
  if (!s.name) return 0;
  const name = s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // a math snippet is `\name` not running on into a longer command; a text snippet is `{{name}}`
  const call = s.kind === 'math' ? new RegExp(`\\\\${name}(?![A-Za-z])`, 'g') : new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
  let n = 0;
  const walk = (v: unknown) => {
    if (typeof v === 'string') n += v.match(call)?.length ?? 0;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(doc.blocks);
  for (const other of doc.snippets) if (other.id !== s.id) walk(other.body);
  return n;
}
