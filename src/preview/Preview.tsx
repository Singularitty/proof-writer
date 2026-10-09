import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { exportTypst } from '../export/typst';
import { exportLatex } from '../export/latex';
import { compileTypst, vectorToSvg } from './compile';
import { splitPages, type PreviewDoc, type PreviewPage } from './pages';
import { anchorSpan, blockAt, type Anchor } from './anchors';
import { jumpToBlock } from '../components/Tracker';
import { download, slug } from '../util/download';
import { desktop } from '../util/desktop';

type Tab = 'pdf' | 'typst' | 'latex';

/** One sheet. Its drawing is only handed to the browser again when it changed, which is what keeps typing smooth in a long document. */
const Page = memo(function Page({ page }: { page: PreviewPage }) {
  return <svg className="typst-doc pw-page" viewBox={`0 0 ${page.width} ${page.height}`} data-height={page.height} dangerouslySetInnerHTML={{ __html: page.body }} />;
});

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

  const [svg, setSvg] = useState<PreviewDoc>({ head: '', pages: [] });
  const [status, setStatus] = useState<{ state: 'loading' | 'ok' | 'error'; msg: string }>({ state: 'loading', msg: 'Loading Typst compiler…' });
  const [diags, setDiags] = useState<string[]>([]);
  const latest = useRef(0);

  useEffect(() => {
    const id = ++latest.current;
    let cancelled = false;
    (async () => {
      if (!svg.pages.length) setStatus({ state: 'loading', msg: 'Loading Typst compiler (first time only)…' });
      const r = await compileTypst(anchored, 'vector');
      if (cancelled || id !== latest.current) return;
      if (!r.ok) {
        setDiags(r.diagnostics);
        setStatus({ state: 'error', msg: 'Typst reported an error' });
        return;
      }
      const s = splitPages(await vectorToSvg(r.data));
      if (cancelled || id !== latest.current) return;
      anchors.current = r.anchors;
      setSvg(s);
      setDiags(r.diagnostics.filter((d) => !/^warning/.test(d)));
      setStatus({ state: 'ok', msg: `Rendered in ${Math.round(r.ms)} ms` });
    })().catch((e) => setStatus({ state: 'error', msg: String(e) }));
    return () => { cancelled = true; };
  }, [anchored]); // eslint-disable-line

  /** Selects the block whose output was clicked. */
  const goToSource = (e: React.MouseEvent) => {
    const papers = [...e.currentTarget.querySelectorAll<SVGSVGElement>('svg.pw-page')];
    const page = papers.findIndex((p) => { const r = p.getBoundingClientRect(); return e.clientY >= r.top && e.clientY <= r.bottom && e.clientX >= r.left && e.clientX <= r.right; });
    if (page < 0) return;
    const r = papers[page].getBoundingClientRect();
    const y = ((e.clientY - r.top) / r.height) * Number(papers[page].dataset.height);
    const id = blockAt(anchors.current, page + 1, y);
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
    const papers = box ? [...box.querySelectorAll<SVGSVGElement>('svg.pw-page')] : [];
    if (!box || !papers.length) return;
    shown.current = target.n;
    const span = anchorSpan(anchors.current, target.id, Number(papers[0].dataset.height));
    const paper = span && papers[span.page - 1];
    if (!span || !paper) return;
    const r = paper.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const scale = r.height / Number(paper.dataset.height);
    const top = r.top - b.top + box.scrollTop + span.y * scale;
    box.scrollTo({ top: Math.max(0, top - 70), behavior: 'smooth' });
    setMark({ n: target.n, top, left: r.left - b.left + box.scrollLeft, width: r.width, height: Math.max(16, (span.end - span.y) * scale) });
  }, [target, tab, svg]); // eslint-disable-line

  const name = slug(doc.title);
  const downloadPdf = async () => {
    const r = await compileTypst(exportTypst(doc).source, 'pdf');
    if (r.ok) download(`${name}.pdf`, r.data, 'application/pdf');
    else alert('Typst error:\n' + r.diagnostics.join('\n'));
  };
  const openPdf = async () => {
    if (desktop) {
      const r = await compileTypst(exportTypst(doc).source, 'pdf');
      if (!r.ok) { alert('Typst error:\n' + r.diagnostics.join('\n')); return; }
      desktop.openPdf(name, r.data as Uint8Array).catch((e) => alert('Could not open the PDF: ' + e));
      return;
    }
    const w = window.open('', '_blank');
    const r = await compileTypst(exportTypst(doc).source, 'pdf');
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
          <div className="pages" onClick={goToSource} title="Click to go to that part of the document">
            {/* what the pages share; never shown itself */}
            <svg className="pw-defs" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg.head }} />
            {svg.pages.map((p, i) => <Page key={i} page={p} />)}
          </div>
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
