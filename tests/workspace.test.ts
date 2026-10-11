import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const ws = createRequire(import.meta.url)('../electron/workspace.cjs');

function folder() {
  const root = mkdtempSync(join(tmpdir(), 'pw-ws-'));
  writeFileSync(join(root, 'b.proof.json'), '{}');
  writeFileSync(join(root, 'a.json'), '{}');
  writeFileSync(join(root, 'notes.typ'), '= hi');
  writeFileSync(join(root, 'readme.md'), 'x');
  writeFileSync(join(root, '.hidden.json'), '{}');
  mkdirSync(join(root, 'chapter 2'));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'chapter 2', 'inner.json'), '{}');
  return root;
}

describe('the open folder', () => {
  it('lists folders first, then documents, and nothing else', async () => {
    const root = folder();
    const l = await ws.listFolder(root);
    expect(l.entries.map((e: { name: string; kind: string }) => `${e.kind}:${e.name}`)).toEqual(['dir:chapter 2', 'file:a.json', 'file:b.proof.json', 'file:notes.typ']);
    expect(l.parent).toBe(null);
  });
  it('lists a subfolder and says where its parent is', async () => {
    const root = folder();
    const l = await ws.listFolder(root, join(root, 'chapter 2'));
    expect(l.entries.map((e: { name: string }) => e.name)).toEqual(['inner.json']);
    expect(l.parent).toBe(root);
  });
  it('refuses anything outside it', async () => {
    const root = folder();
    await expect(ws.listFolder(root, join(root, '..'))).rejects.toThrow(/outside/);
    await expect(ws.createFile(root, tmpdir(), 'x', '{}')).rejects.toThrow(/outside/);
    await expect(ws.renameFile(root, join(root, '..', 'x.json'), 'y')).rejects.toThrow(/outside/);
    expect(ws.inside(root, root + '-other')).toBe(false);
    expect(ws.inside(root, join(root, 'chapter 2', 'inner.json'))).toBe(true);
  });
});

describe('creating a document', () => {
  it('adds the extension and never overwrites', async () => {
    const root = folder();
    const p1 = await ws.createFile(root, root, 'Untitled', 'one');
    const p2 = await ws.createFile(root, root, 'Untitled', 'two');
    expect(basename(p1)).toBe('Untitled.proof.json');
    expect(basename(p2)).toBe('Untitled 2.proof.json');
    expect(readFileSync(p1, 'utf8')).toBe('one');
    expect(readFileSync(p2, 'utf8')).toBe('two');
  });
  it('strips anything that would put the file elsewhere', async () => {
    const root = folder();
    const p = await ws.createFile(root, root, '../../evil/name', '{}');
    expect(ws.inside(root, p)).toBe(true);
    expect(basename(p)).toBe('evilname.proof.json');
    await expect(ws.createFile(root, root, '  ', '{}')).rejects.toThrow(/name/);
  });
});

describe('renaming a document', () => {
  it('keeps the extension when none is given', async () => {
    const root = folder();
    const p = await ws.renameFile(root, join(root, 'b.proof.json'), 'soundness');
    expect(basename(p)).toBe('soundness.proof.json');
    expect(existsSync(join(root, 'b.proof.json'))).toBe(false);
    expect(basename(await ws.renameFile(root, join(root, 'notes.typ'), 'draft'))).toBe('draft.typ');
  });
  it('refuses to replace another file', async () => {
    const root = folder();
    await expect(ws.renameFile(root, join(root, 'a.json'), 'b.proof.json')).rejects.toThrow(/already/);
    expect(existsSync(join(root, 'a.json'))).toBe(true);
  });
  it('does nothing when the name is unchanged', async () => {
    const root = folder();
    expect(await ws.renameFile(root, join(root, 'a.json'), 'a.json')).toBe(join(root, 'a.json'));
  });
});
