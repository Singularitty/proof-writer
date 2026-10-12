import { useDeferredValue, useEffect } from 'react';
import { useStore } from '../store';
import { useLean, type RunningJob } from '../lean/store';
import { leanView, type LeanProposal, type LeanRow, type LeanView, type RowStatus } from '../lean/view';
import { EFFORTS, MODELS, type Effort, type Model } from '../lean/prompt';
import type { Finding } from '../lean/status';
import { desktop } from '../util/desktop';
import { jumpToBlock } from './Tracker';
import { useNumbering } from './ProseView';

const STATUS: Record<RowStatus, string> = {
  none: 'Not translated',
  stale: 'Out of date',
  translated: 'Translated',
  stated: 'Stated, not proved',
  proved: 'Proved',
  deviations: 'Proved with deviations',
  failed: 'Failed',
};
const FINDING: Record<Finding['kind'], string> = { deviation: 'Deviation', inconsistency: 'Inconsistency', stuck: 'Stuck' };
const MODEL_NAME: Record<Model, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const EFFORT_NAME: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** Keeps the Lean state on the file of the open document. Called once, by the app. */
export function useLeanDocument() {
  const file = useStore((s) => s.index.find((m) => m.id === s.docId)?.file ?? null);
  useEffect(() => { void useLean.getState().load(file); }, [file]);
}

/** The Lean rows for the open document, a beat behind typing. */
export function useLeanView(): LeanView {
  const doc = useDeferredValue(useStore((s) => s.doc));
  const mech = useLean((s) => s.mech);
  return leanView(doc, mech);
}

/** What to call a row: "Lemma 2 (Canonical forms)", "Rules: Typing". */
function useRowName() {
  const num = useNumbering();
  return (row: LeanRow) => {
    const { item } = row;
    if (item.kind === 'grammar') return `Grammar${item.title ? `: ${item.title}` : ''}`;
    if (item.kind === 'rules') return `Rules${item.title ? `: ${item.title}` : ''}`;
    return `${num.byId.get(row.id) ?? 'Statement'}${item.title ? ` (${item.title})` : ''}`;
  };
}

export function Lean() {
  const { tools, docPath, dir, job, error, mech, focus } = useLean();
  const view = useLeanView();
  const name = useRowName();

  useEffect(() => {
    if (!focus) return;
    document.getElementById('lean-row-' + focus.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    useLean.getState().clearFocus();
  }, [focus]);

  if (!desktop) return null;
  if (desktop.platform === 'win32') return <p className="dim">Mechanizing in Lean is not supported on Windows yet.</p>;
  if (!docPath) return <p className="dim">Save the document to a file to mechanize it. Its Lean files are kept in a folder beside it.</p>;
  if (!tools) return error ? <ErrorBox error={error} onCheck={() => void useLean.getState().checkTools()} /> : <p className="dim">Looking for Claude Code and Lean…</p>;
  if (!tools.claude || !tools.lake) return <Setup claude={!!tools.claude} lake={!!tools.lake} />;

  // the folder could not be opened, so there is nothing to show but why
  if (!dir && error) return <ErrorBox error={error} />;

  const busy = job !== null;
  // until the folder has been opened a job could not start
  const ready = !busy && dir !== null;
  const { sync, prove, cancel, reveal, recreate } = useLean.getState();
  /** The name of the statement a job is working on; its row may be gone if the document changed. */
  const targetName = (id: string) => {
    const r = view.byId.get(id);
    return r ? name(r) : 'a statement';
  };
  return (
    <div className="lean">
      <div className="lean-bar">
        <button className="primary" disabled={!ready} onClick={() => void sync()} title="Translate the definitions and state every lemma and theorem in Lean">
          Sync definitions{view.outOfDate > 0 && <span className="tab-count">{view.outOfDate}</span>}
        </button>
        <Choices disabled={busy} />
      </div>
      {job && <Running job={job} name={job.target ? targetName(job.target) : ''} onCancel={cancel} />}
      {error && <ErrorBox error={error} busy={busy} onRecreate={() => void recreate()} />}
      {view.definitions.length > 0 && <h4>Definitions</h4>}
      {view.definitions.map((r) => <Row key={r.id} row={r} name={name} busy={busy} ready={ready} />)}
      {view.statements.length > 0 && <h4>Statements</h4>}
      {view.statements.map((r) => <Row key={r.id} row={r} name={name} busy={busy} ready={ready} onProve={() => void prove(r.id)} />)}
      {view.definitions.length + view.statements.length === 0 && <p className="dim">No grammars, rules, definitions or statements yet.</p>}
      {view.loose.length > 0 && <h4>Other proposed edits</h4>}
      {view.loose.map((p) => <ProposalView key={p.id} p={p} busy={busy} />)}
      {mech.lastJob && <LastJob />}
      {dir && <p className="lean-dir dim">Lean files: <a onClick={reveal} title={dir}>{dir.split(/[\\/]/).pop()}</a></p>}
    </div>
  );
}

function ErrorBox({ error, busy, onRecreate, onCheck }: { error: string; busy?: boolean; onRecreate?: () => void; onCheck?: () => void }) {
  return (
    <div className="lean-error">
      <p>{error}</p>
      {onCheck && <button className="mini" onClick={onCheck}>Check again</button>}
      {onRecreate && /lake build could not run/.test(error) && <button className="mini" disabled={busy} onClick={onRecreate}>Recreate project files</button>}
    </div>
  );
}

function Setup({ claude, lake }: { claude: boolean; lake: boolean }) {
  return (
    <div className="lean-setup">
      <p>Mechanizing a document needs two programs on this computer.</p>
      {!claude && (
        <p><strong>Claude Code</strong> was not found. Install it from <a href="https://claude.com/claude-code" target="_blank" rel="noreferrer">claude.com/claude-code</a> and sign in by running <code>claude</code> once in a terminal.</p>
      )}
      {!lake && (
        <p>
          <strong>Lean</strong> was not found. Install it by running this in a terminal:<code className="lean-cmd">curl https://elan.lean-lang.org/elan-init.sh -sSf | sh</code>
        </p>
      )}
      <button onClick={() => void useLean.getState().checkTools()}>Check again</button>
    </div>
  );
}

function Choices({ disabled }: { disabled: boolean }) {
  const model = useLean((s) => s.model);
  const effort = useLean((s) => s.effort);
  const { setModel, setEffort } = useLean.getState();
  return (
    <span className="lean-choices">
      <select value={model} disabled={disabled} onChange={(e) => setModel(e.target.value as Model | '')} title="The model the next job runs with. Default leaves it to your Claude Code settings." aria-label="Model">
        <option value="">Default model</option>
        {MODELS.map((m) => <option key={m} value={m}>{MODEL_NAME[m]}</option>)}
      </select>
      <select value={effort} disabled={disabled} onChange={(e) => setEffort(e.target.value as Effort | '')} title="How hard the next job thinks. Default leaves it to your Claude Code settings." aria-label="Effort">
        <option value="">Default effort</option>
        {EFFORTS.map((x) => <option key={x} value={x}>{EFFORT_NAME[x]}</option>)}
      </select>
    </span>
  );
}

function Running({ job, name, onCancel }: { job: RunningJob; name: string; onCancel: () => void }) {
  const what = job.kind === 'sync' ? 'Syncing definitions' : `Proving ${name}`;
  const settings = [job.model && MODEL_NAME[job.model as Model], job.effort && EFFORT_NAME[job.effort as Effort].toLowerCase()].filter(Boolean).join(', ');
  return (
    <div className="lean-job">
      <div className="lean-job-head">
        <strong role="status">{what}{settings && ` · ${settings}`}</strong>
        <button className="mini danger" onClick={onCancel}>Cancel</button>
      </div>
      {job.lines.length ? <ul>{job.lines.map((l, i) => <li key={i}>{l}</li>)}</ul> : <p className="dim">Starting…</p>}
    </div>
  );
}

function Row({ row, name, busy, ready, onProve }: { row: LeanRow; name: (r: LeanRow) => string; busy: boolean; ready: boolean; onProve?: () => void }) {
  const view = useLeanView();
  const attempted = row.status === 'proved' || row.status === 'deviations' || row.status === 'failed';
  const assumes = row.assumes.map((id) => { const r = view.byId.get(id); return r ? name(r) : id; });
  return (
    <section className="tk-group lean-row" id={'lean-row-' + row.id}>
      <div className="lean-row-head">
        <a className="tk-head" onClick={() => jumpToBlock(row.id)} title="Go to this block">
          <span className={'tk-dot lean-' + row.status} />
          <span className="tk-name">{name(row)}</span>
        </a>
        {onProve && row.canProve && <button className="mini" disabled={!ready} onClick={onProve}>{attempted ? 'Prove again' : 'Prove'}</button>}
      </div>
      <div className="tk-line dim">
        {STATUS[row.status]}{assumes.length > 0 && `, assuming ${assumes.join(', ')}`}{row.file && ` · ${row.file}`}
      </div>
      {row.proofChanged && <div className="tk-line dim">The written proof has changed since.</div>}
      {row.findings.length > 0 && (
        <ul className="tk-issues">
          {row.findings.map((f, i) => (
            <li key={i} className={f.kind === 'deviation' ? 'info' : f.kind === 'inconsistency' ? 'warning' : 'error'}>
              <a onClick={() => jumpToBlock(row.id)}>
                <span className="tk-where">{FINDING[f.kind]}</span> {f.message}
                {f.lean && <span className="dim"> ({f.lean.file}:{f.lean.line})</span>}
              </a>
            </li>
          ))}
        </ul>
      )}
      {row.proposals.map((p) => <ProposalView key={p.id} p={p} busy={busy} />)}
    </section>
  );
}

const settleWait = 'Proposals can be settled once the job has finished.';

function ProposalView({ p, busy }: { p: LeanProposal; busy: boolean }) {
  const { settle } = useLean.getState();
  return (
    <div className="lean-proposal">
      <div className="lean-proposal-head">Proposed edit{p.why && <span className="dim">: {p.why}</span>}</div>
      {p.before && <pre className="lean-before">{p.before}</pre>}
      {p.after ? <pre className="lean-after">{p.after}</pre> : <div className="dim">(remove it)</div>}
      <div className="row">
        <button className="mini primary" disabled={busy || !p.applicable} onClick={() => void settle(p.id, true)} title={busy ? settleWait : p.applicable ? 'Make this edit in the document' : 'The text has changed since this was proposed'}>Accept</button>
        <button className="mini" disabled={busy} onClick={() => void settle(p.id, false)} title={busy ? settleWait : undefined}>Dismiss</button>
        <a className="dim" onClick={() => jumpToBlock(p.block)}>show</a>
        {!p.applicable && <span className="dim">no longer applies</span>}
      </div>
    </div>
  );
}

function LastJob() {
  const job = useLean((s) => s.mech.lastJob)!;
  const what = job.kind === 'sync' ? 'Last sync' : 'Last proof';
  return (
    <details className="lean-last">
      <summary>{what}: {job.outcome}, {new Date(job.endedAt).toLocaleString()}</summary>
      {job.summary && <p>{job.summary}</p>}
      {job.changes.length > 0 ? (
        <ul>{job.changes.map((c, i) => <li key={i}>
            {c.name === '(file)' && c.change === 'removed'
              ? <><code>{c.file}</code> <span className="dim">moved to the trash</span></>
              : <><span className={'lean-change ' + c.change}>{c.change}</span> <code>{c.name}</code> <span className="dim">{c.file}</span></>}
          </li>)}</ul>
      ) : <p className="dim">No Lean declarations were reported as changed.</p>}
    </details>
  );
}

/** The status dot on a statement in the editor; clicking it opens the Lean tab at that statement. */
export function LeanDot({ id }: { id: string }) {
  const hasFile = useLean((s) => s.docPath !== null);
  const row = useLeanView().byId.get(id);
  if (!desktop || !hasFile || !row || row.status === 'none') return null;
  return <button className={'lean-dot tk-dot lean-' + row.status} title={`Lean: ${STATUS[row.status]}`} aria-label={`Lean: ${STATUS[row.status]}`} onClick={() => useLean.getState().show(id)} />;
}
