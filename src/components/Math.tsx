import katex from 'katex';
import { memo, useMemo } from 'react';
import { useStore } from '../store';
import { katexMacros } from '../latex/macros';
import type { Doc } from '../model/types';

let cachedSnippets: Doc['snippets'] | null = null;
let cachedMacros: Record<string, string> = {};

export function useMacros(): Record<string, string> {
  const snippets = useStore((s) => s.doc.snippets);
  if (snippets !== cachedSnippets) {
    cachedSnippets = snippets;
    cachedMacros = katexMacros(
      snippets.filter((s) => s.kind === 'math').map((s) => ({ name: s.name, arity: s.arity, body: s.body })),
    );
  }
  return cachedMacros;
}

export function renderTex(src: string, macros: Record<string, string>, display = false): string {
  try {
    return katex.renderToString(src, {
      displayMode: display,
      throwOnError: true,
      macros: { ...macros },
      strict: false,
      trust: false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/^KaTeX parse error: /, '') : String(e);
    const safe = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<span class="tex-error" title="${safe(msg)}">${safe(src)}</span>`;
  }
}

export const Math = memo(function Math({ tex, display, className }: { tex: string; display?: boolean; className?: string }) {
  const macros = useMacros();
  const html = useMemo(() => renderTex(tex, macros, display), [tex, macros, display]);
  return <span className={'math ' + (className ?? '')} dangerouslySetInnerHTML={{ __html: html }} />;
});
