import { useStore, type DocMeta } from '../store';
import { importTypst } from '../import/typst';
import { desktop, markSaved, setDocFilePath } from './desktop';
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
