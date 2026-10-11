import { useStore, type DocMeta } from '../store';
import { importTypst } from '../import/typst';
import { desktop, markSaved, setDocFilePath } from './desktop';
import { hasUnsavedEdits } from '../store';
import type { Doc } from '../model/types';

/**
 * Opens a saved .json document, or imports a Typst file, as a new document in the
 * library. `meta` is attached to its library entry (e.g. the GitHub file it came from).
 * Returns false (after telling the user) if the file couldn't be read.
 */
export function loadFile(text: string, path?: string, name = path ?? '', meta?: Partial<DocMeta>): boolean {
  if (/\.typ$/i.test(name)) {
    const { doc, warnings } = importTypst(text);
    useStore.getState().importDoc(doc, meta);
    if (warnings.length) {
      alert(`Imported with ${warnings.length} note${warnings.length > 1 ? 's' : ''}:\n\n` + warnings.slice(0, 20).map((w) => '• ' + w).join('\n') + (warnings.length > 20 ? '\n…' : ''));
    }
    return true;
  }
  try {
    const d = JSON.parse(text) as Doc;
    if (!Array.isArray(d.blocks) || !Array.isArray(d.snippets)) throw new Error('not a proof-writer document');
    d.settings ??= { paper: 'a4', fontSize: 11, numberTheorems: 'shared' };
    // A file that is already in the library is shown, not opened a second time. Its
    // contents are taken from disk unless that would discard edits not yet saved there.
    const already = path ? useStore.getState().index.find((m) => m.file === path) : undefined;
    if (already && path) {
      const st = useStore.getState();
      if (st.docId !== already.id) st.openDoc(already.id);
      const open = useStore.getState();
      if (!hasUnsavedEdits(already) && JSON.stringify(open.doc, null, 2) !== text) open.replaceDoc(d);
      if (!hasUnsavedEdits(already)) markSaved(already.id, useStore.getState().doc, text);
      void desktop?.watchDocument(path);
      return true;
    }
    useStore.getState().importDoc(d, meta);
    if (path) {
      const { docId, doc } = useStore.getState();
      setDocFilePath(docId, path);
      markSaved(docId, doc, text);
      void desktop?.watchDocument(path);
    }
    return true;
  } catch (e) {
    alert('Could not open that file: ' + (e instanceof Error ? e.message : e));
    return false;
  }
}
