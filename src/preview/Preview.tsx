import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { exportTypst } from '../export/typst';
import { exportLatex } from '../export/latex';
import { compileTypst, vectorToSvg } from './compile';
import { separatePages } from './pages';
import { download, slug } from '../util/download';
import { desktop } from '../util/desktop';

/** Space between pages in the preview, in points of the page. */
const PAGE_GAP = 14;

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
  const latex = useMemo(() => (tab === 'latex' ? exportLatex(debounced) : null), [debounced, tab]);

  const [svg, setSvg] = useState<string>('');
  const [status, setStatus] = useState<{ state: 'loading' | 'ok' | 'error'; msg: string }>({ state: 'loading', msg: 'Loading Typst compiler…' });
  const [diags, setDiags] = useState<string[]>([]);
  const latest = useRef(0);

  useEffect(() => {
    const id = ++latest.current;
    let cancelled = false;
    (async () => {
      if (!svg) setStatus({ state: 'loading', msg: 'Loading Typst compiler (first time only)…' });
      const r = await compileTypst(typst.source, 'vector');
      if (cancelled || id !== latest.current) return;
      if (!r.ok) {
        setDiags(r.diagnostics);
        setStatus({ state: 'error', msg: 'Typst reported an error' });
        return;
      }
      const s = separatePages(await vectorToSvg(r.data), PAGE_GAP);
      if (cancelled || id !== latest.current) return;
      setSvg(s);
      setDiags(r.diagnostics.filter((d) => !/^warning/.test(d)));
      setStatus({ state: 'ok', msg: `Rendered in ${Math.round(r.ms)} ms` });
    })().catch((e) => setStatus({ state: 'error', msg: String(e) }));
    return () => { cancelled = true; };
  }, [typst.source]); // eslint-disable-line

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
            <button onClick={() => navigator.clipboard?.writeText(code)}>Copy</button>
            <button onClick={() => download(`${name}.${tab === 'typst' ? 'typ' : 'tex'}`, code, 'text/plain')}>⤓ .{tab === 'typst' ? 'typ' : 'tex'}</button>
          </>
        )}
      </div>
      {tab === 'pdf' && (
        <div className="pdf-wrap">
          <div className={'status ' + status.state}>{status.msg}</div>
          {diags.length > 0 && (
            <div className="diags">
              {diags.map((d, i) => <div key={i}>{d}</div>)}
              <div className="dim">Check the Typst tab; a raw block or an unusual LaTeX command is the usual cause.</div>
            </div>
          )}
          <div className="pages" dangerouslySetInnerHTML={{ __html: svg }} />
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
