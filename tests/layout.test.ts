import { describe, it, expect } from 'vitest';
import { ALL_VIEWS, dockedViews, gridColumns, makeRoomToDetach, minWidth, openCount, readViews, showView, toggleView } from '../src/model/layout';

const only = (...open: string[]) => ({ sidebar: open.includes('sidebar'), editor: open.includes('editor'), preview: open.includes('preview') });

describe('toggleView', () => {
  it('collapses an open view and opens a collapsed one', () => {
    expect(toggleView(ALL_VIEWS, 'sidebar')).toEqual(only('editor', 'preview'));
    expect(toggleView(only('editor'), 'preview')).toEqual(only('editor', 'preview'));
  });
  it('leaves the last open view open', () => {
    const v = only('preview');
    expect(toggleView(v, 'preview')).toBe(v);
  });
});

describe('showView', () => {
  it('opens a collapsed view and keeps the same object when it is already open', () => {
    expect(showView(only('editor'), 'preview')).toEqual(only('editor', 'preview'));
    expect(showView(ALL_VIEWS, 'preview')).toBe(ALL_VIEWS);
  });
});

describe('gridColumns', () => {
  it('keeps the three columns and the splitter when everything is open', () => {
    expect(gridColumns(ALL_VIEWS, 640)).toBe('minmax(220px, 300px) minmax(420px, 1fr) 6px minmax(260px, 640px)');
  });
  it('drops the columns of collapsed views', () => {
    expect(gridColumns(only('editor', 'preview'), 500)).toBe('minmax(420px, 1fr) 6px minmax(260px, 500px)');
    expect(gridColumns(only('sidebar', 'editor'), 500)).toBe('minmax(220px, 300px) minmax(420px, 1fr)');
  });
  it('gives the spare room to the preview when the editor is collapsed', () => {
    expect(gridColumns(only('sidebar', 'preview'), 500)).toBe('minmax(220px, 300px) minmax(260px, 1fr)');
    expect(gridColumns(only('preview'), 500)).toBe('minmax(260px, 1fr)');
  });
  it('lets the sidebar fill the window when it is alone', () => {
    expect(gridColumns(only('sidebar'), 500)).toBe('minmax(220px, 1fr)');
  });
});

describe('minWidth', () => {
  it('is the room the open views need', () => {
    expect(minWidth(ALL_VIEWS)).toBe(906);
    expect(minWidth(only('sidebar', 'editor'))).toBe(640);
    expect(minWidth(only('sidebar', 'preview'))).toBe(480);
    expect(minWidth(only('editor'))).toBe(420);
  });
});

describe('readViews', () => {
  it('reads back what was saved', () => {
    expect(readViews({ sidebar: false, editor: true, preview: true })).toEqual(only('editor', 'preview'));
  });
  it('opens everything when nothing usable was saved', () => {
    expect(readViews(null)).toEqual(ALL_VIEWS);
    expect(readViews('nonsense')).toEqual(ALL_VIEWS);
    expect(readViews({ sidebar: false, editor: false, preview: false })).toEqual(ALL_VIEWS);
  });
  it('treats a missing view as open', () => {
    expect(readViews({ preview: false })).toEqual(only('sidebar', 'editor'));
  });
});

describe('openCount', () => {
  it('counts the open views', () => {
    expect(openCount(only('sidebar', 'preview'))).toBe(2);
  });
});

describe('a preview detached into its own window', () => {
  it('takes no room in the main window', () => {
    expect(dockedViews(ALL_VIEWS, true)).toEqual(only('sidebar', 'editor'));
    expect(dockedViews(ALL_VIEWS, false)).toBe(ALL_VIEWS);
  });
  it('does not count as a view left open in the main window', () => {
    const v = only('editor', 'preview');
    expect(toggleView(v, 'editor', true)).toBe(v);
    expect(toggleView(ALL_VIEWS, 'editor', true)).toEqual(only('sidebar', 'preview'));
  });
  it('opens the editor when the preview was the only view', () => {
    expect(makeRoomToDetach(only('preview'))).toEqual(only('editor', 'preview'));
    const v = only('sidebar', 'preview');
    expect(makeRoomToDetach(v)).toBe(v);
  });
});
