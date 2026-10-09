import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { exportTypst } from '../export/typst';
import { exportLatex } from '../export/latex';
import { compilePdf, livePages, pageHeights, renderLive } from './compile';
import { PAGE_GAP, locate, pageTops, totalHeight } from './pages';
import { anchorSpan, blockAt, type Anchor } from './anchors';
import { jumpToBlock } from '../components/Tracker';
import { download, slug } from '../util/download';
import { desktop } from '../util/desktop';

type Tab = 'pdf' | 'typst' | 'latex';

export function Preview() {
  const doc = useStore((s) => s.doc);
  const [tab, setTab] = useState<Tab>('pdf');
  const [debounced, setDebounced] = useState(doc);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(doc), 350);
    return () => clearTimeout(t);
  }, [doc]);
  const typst = useMemo(() => exportTypst(debounced), [debounced]);
  // what the preview compiles: the same document, with a mark where each block starts
  const anchored = useMemo(() => exportTypst(debounced, { anchors: true }).source, [debounced]);
  const anchors = useRef<Anchor[]>([]);
  const latex = useMemo(() => (tab === 'latex' ? exportLatex(debounced) : null), [debounced, tab]);

  /** Counts the times the drawing was brought up to date. */
  const [drawn, setDrawn] = useState(0);
  const [status, setStatus] = useState<{ state: 'loading' | 'ok' | 'error'; msg: string }>({ state: 'loading', msg: 'Loading Typst compiler…' });
  const [diags, setDiags] = useState<string[]>([]);
  const latest = useRef(0);

  useEffect(() => {
    const id = ++latest.current;
    let cancelled = false;
    (async () => {
      if (!pageHeights().length) setStatus({ state: 'loading', msg: 'Loading Typst compiler (first time only)…' });
      // the drawing itself is updated in place by renderLive, whether or not this result is still the newest
      const r = await renderLive(anchored);
      if (r.ok) anchors.current = r.anchors;
      if (cancelled || id !== latest.current) return;
      if (!r.ok) {
        setDiags(r.diagnostics);
        setStatus({ state: 'error', msg: 'Typst reported an error' });
        return;
      }
      setDrawn((n) => n + 1);
      setDiags(r.diagnostics.filter((d) => !/^warning/.test(d)));
      setStatus({ state: 'ok', msg: `Rendered in ${Math.round(r.ms)} ms` });
    })().catch((e) => setStatus({ state: 'error', msg: String(e) }));
    return () => { cancelled = true; };
  }, [anchored]); // eslint-disable-line

  // the drawing lives outside React; show it here while the PDF tab is open
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tab === 'pdf' && livePages && host.current) host.current.appendChild(livePages);
  }, [tab]);

  /** The drawing's place on screen and how many pixels one of its points takes. */
  const geometry = () => {
    const el = livePages?.firstElementChild;
    const total = totalHeight(pageHeights(), PAGE_GAP);
    if (!el || !total) return null;
    const r = el.getBoundingClientRect();
    return { r, scale: r.height / total };
  };

  /** Selects the block whose output was clicked. */
  const goToSource = (e: React.MouseEvent) => {
    const g = geometry();
    if (!g || e.clientX < g.r.left || e.clientX > g.r.right) return;
    const at = locate(pageHeights(), PAGE_GAP, (e.clientY - g.r.top) / g.scale);
    const id = at && blockAt(anchors.current, at.page, at.y);
    if (id) jumpToBlock(id);
  };

  // "Show in PDF" on a block: scroll its output into view and mark it for a moment
  const target = useStore((s) => s.pdfTarget);
  const shown = useRef(0);
  const wrap = useRef<HTMLDivElement>(null);
  const [mark, setMark] = useState<{ n: number; top: number; left: number; width: number; height: number } | null>(null);
  useEffect(() => {
    if (!target || shown.current === target.n) return;
    if (tab !== 'pdf') { setTab('pdf'); return; }
    const box = wrap.current;
    const g = geometry();
    if (!box || !g) return;
    shown.current = target.n;
    const heights = pageHeights();
    const first = anchors.current.find((x) => x.id === target.id);
    const span = first && anchorSpan(anchors.current, target.id, heights[first.page - 1]);
    if (!span) return;
    const b = box.getBoundingClientRect();
    const top = g.r.top - b.top + box.scrollTop + (pageTops(heights, PAGE_GAP)[span.page - 1] + span.y) * g.scale;
    box.scrollTo({ top: Math.max(0, top - 70), behavior: 'smooth' });
    setMark({ n: target.n, top, left: g.r.left - b.left + box.scrollLeft, width: g.r.width, height: Math.max(16, (span.end - span.y) * g.scale) });
  }, [target, tab, drawn]); // eslint-disable-line

  const name = slug(doc.title);
  const downloadPdf = async () => {
    const r = await compilePdf(exportTypst(doc).source);
    if (r.ok) download(`${name}.pdf`, r.data, 'application/pdf');
    else alert('Typst error:\n' + r.diagnostics.join('\n'));
  };
  const openPdf = async () => {
    if (desktop) {
      const r = await compilePdf(exportTypst(doc).source);
      if (!r.ok) { alert('Typst error:\n' + r.diagnostics.join('\n')); return; }
      desktop.openPdf(name, r.data as Uint8Array).catch((e) => alert('Could not open the PDF: ' + e));
      return;
    }
    const w = window.open('', '_blank');
    const r = await compilePdf(exportTypst(doc).source);
    if (!r.ok) { w?.close(); alert('Typst error:\n' + r.diagnostics.join('\n')); return; }
    const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }));
    if (w) w.location.href = url;
  };

  const warnings = [...typst.warnings, ...(latex?.warnings ?? [])];
  const code = tab === 'typst' ? typst.source : tab === 'latex' ? latex?.source ?? '' : '';

  return (
    <div className="preview">
      <div className="preview-bar">
        <div className="tabs">
          <button className={tab === 'pdf' ? 'active' : ''} onClick={() => setTab('pdf')}>PDF</button>
          <button className={tab === 'typst' ? 'active' : ''} onClick={() => setTab('typst')}>Typst</button>
          <button className={tab === 'latex' ? 'active' : ''} onClick={() => setTab('latex')}>LaTeX</button>
        </div>
        <span className="grow" />
        {tab === 'pdf' && (
          <>
            <button onClick={openPdf} title="Open the PDF in a new tab">Open PDF</button>
            <button onClick={downloadPdf}>⤓ PDF</button>
          </>
        )}
        {tab !== 'pdf' && (
          <>
            <button onClick={() => { navigator.clipboard?.writeText(code).catch(() => alert('The browser did not allow copying. Select the text and copy it by hand.')); }}>Copy</button>
            <button onClick={() => download(`${name}.${tab === 'typst' ? 'typ' : 'tex'}`, code, 'text/plain')}>⤓ .{tab === 'typst' ? 'typ' : 'tex'}</button>
          </>
        )}
      </div>
      {tab === 'pdf' && (
        <div className="pdf-wrap" ref={wrap}>
          <div className={'status ' + status.state}>{status.msg}</div>
          {diags.length > 0 && (
            <div className="diags">
              {diags.map((d, i) => <div key={i}>{d}</div>)}
              <div className="dim">Check the Typst tab; a raw block or an unusual LaTeX command is the usual cause.</div>
            </div>
          )}
          {mark && <div key={mark.n} className="pdf-mark" style={{ top: mark.top, left: mark.left, width: mark.width, height: mark.height }} onAnimationEnd={() => setMark(null)} />}
          <div ref={host} onClick={goToSource} title="Click to go to that part of the document" />
        </div>
      )}
      {tab !== 'pdf' && <pre className="code">{code}</pre>}
      {warnings.length > 0 && (
        <div className="warnings">
          {[...new Set(warnings)].slice(0, 8).map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
    </div>
  );
}
