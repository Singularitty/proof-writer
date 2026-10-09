import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { watchFile } = createRequire(import.meta.url)('../electron/watch.cjs');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('watching a document file', () => {
  it('reports new contents, including a save by rename, and stops when closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-watch-'));
    const file = join(dir, 'doc.json');
    writeFileSync(file, 'one');
    const seen: string[] = [];
    const stop = watchFile(file, (text: string) => seen.push(text));
    await wait(50);
    writeFileSync(file, 'two');
    await wait(400);
    writeFileSync(join(dir, 'tmp'), 'three');
    renameSync(join(dir, 'tmp'), file);
    await wait(400);
    expect(seen).toEqual(['two', 'three']);
    stop();
    writeFileSync(file, 'four');
    await wait(400);
    expect(seen).toEqual(['two', 'three']);
  });
  it('does not report a write that leaves the contents unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pw-watch-'));
    const file = join(dir, 'doc.json');
    writeFileSync(file, 'one');
    const seen: string[] = [];
    const stop = watchFile(file, (text: string) => seen.push(text));
    await wait(50);
    writeFileSync(file, 'one');
    await wait(400);
    stop();
    expect(seen).toEqual([]);
  });
});
