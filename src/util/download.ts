import { desktop } from './desktop';

const FILTERS: Record<string, { name: string; extensions: string[] }> = {
  pdf: { name: 'PDF', extensions: ['pdf'] },
  typ: { name: 'Typst', extensions: ['typ'] },
  tex: { name: 'LaTeX', extensions: ['tex'] },
  json: { name: 'Proof Writer document', extensions: ['json'] },
};

/** Saves a file: a native save dialog in the desktop app, a browser download otherwise. */
export function download(filename: string, data: string | Uint8Array, type: string) {
  if (desktop) {
    const ext = filename.split('.').pop() ?? '';
    desktop.saveFile(filename, data, FILTERS[ext] ? [FILTERS[ext]] : []).catch((e) => alert('Could not save: ' + e));
    return;
  }
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function slug(s: string): string {
  return (s || 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'document';
}
