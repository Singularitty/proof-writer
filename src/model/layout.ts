/** The three columns of the window. Each can be collapsed, but never all of them at once. */
export type View = 'sidebar' | 'editor' | 'preview';
export type Views = Record<View, boolean>;

export const VIEWS: View[] = ['sidebar', 'editor', 'preview'];
export const ALL_VIEWS: Views = { sidebar: true, editor: true, preview: true };

const MIN: Record<View, number> = { sidebar: 220, editor: 420, preview: 260 };
const SPLITTER = 6;

export const openCount = (v: Views) => VIEWS.filter((k) => v[k]).length;

/** The splitter sets the preview's width against the editor, so it needs both. */
export const hasSplitter = (v: Views) => v.editor && v.preview;

/** The views in the main window: a preview detached into a window of its own is not one of them. */
export const dockedViews = (v: Views, previewDetached: boolean): Views => (previewDetached && v.preview ? { ...v, preview: false } : v);

/** Collapses or opens a view. The last view open in the main window stays open. */
export function toggleView(v: Views, which: View, previewDetached = false): Views {
  const docked = dockedViews(v, previewDetached);
  if (docked[which] && openCount(docked) === 1) return v;
  return { ...v, [which]: !v[which] };
}

/** Before the preview leaves the main window, makes sure something else is open there. */
export function makeRoomToDetach(v: Views): Views {
  return v.sidebar || v.editor ? v : { ...v, editor: true };
}

export function showView(v: Views, which: View): Views {
  return v[which] ? v : { ...v, [which]: true };
}

/** What was saved last time, with everything open if that is missing or would leave nothing to see. */
export function readViews(saved: unknown): Views {
  if (!saved || typeof saved !== 'object') return ALL_VIEWS;
  const s = saved as Partial<Record<View, unknown>>;
  const v = { sidebar: s.sidebar !== false, editor: s.editor !== false, preview: s.preview !== false };
  return openCount(v) ? v : ALL_VIEWS;
}

/** Grid columns for the open views. Spare room goes to the editor, or without it the preview, or else the sidebar. */
export function gridColumns(v: Views, previewWidth: number): string {
  const cols: string[] = [];
  if (v.sidebar) cols.push(`minmax(${MIN.sidebar}px, ${v.editor || v.preview ? '300px' : '1fr'})`);
  if (v.editor) cols.push(`minmax(${MIN.editor}px, 1fr)`);
  if (hasSplitter(v)) cols.push(`${SPLITTER}px`);
  if (v.preview) cols.push(`minmax(${MIN.preview}px, ${v.editor ? previewWidth + 'px' : '1fr'})`);
  return cols.join(' ');
}

/** The narrowest the window can be before the open views no longer fit. */
export function minWidth(v: Views): number {
  return VIEWS.reduce((w, k) => w + (v[k] ? MIN[k] : 0), hasSplitter(v) ? SPLITTER : 0);
}
