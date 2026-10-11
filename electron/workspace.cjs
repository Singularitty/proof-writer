// The folder a window works in: listing it, and creating and renaming documents
// there. Every path is checked against the folder first, so the window can
// only reach what the user chose to open.
const fs = require('node:fs/promises');
const path = require('node:path');

const DOCUMENT = /\.(json|typ)$/i;

/** True when `p` is `root` or lies under it. */
function inside(root, p) {
  const r = path.resolve(root);
  const q = path.resolve(p);
  return q === r || q.startsWith(r + path.sep);
}

function mustBeInside(root, p) {
  if (!root || !inside(root, p)) throw new Error('That path is outside the open folder.');
  return path.resolve(p);
}

/** Subfolders and documents of `dir`, folders first. Hidden entries and node_modules are left out. */
async function listFolder(root, dir = root) {
  const at = mustBeInside(root, dir);
  const out = [];
  for (const e of await fs.readdir(at, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(at, e.name);
    if (e.isDirectory()) out.push({ name: e.name, path: p, kind: 'dir', modified: 0 });
    else if (e.isFile() && DOCUMENT.test(e.name)) out.push({ name: e.name, path: p, kind: 'file', modified: (await fs.stat(p)).mtimeMs });
  }
  out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1));
  return { root: path.resolve(root), dir: at, parent: at === path.resolve(root) ? null : path.dirname(at), entries: out };
}

/** A file name with nothing that could move it to another folder, ending in a document extension. */
function cleanName(name, fallbackExt = '.proof.json') {
  const base = String(name).trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/^\.+/, '');
  if (!base) throw new Error('A file needs a name.');
  return DOCUMENT.test(base) ? base : base + fallbackExt;
}

/** `name` if nothing in `dir` has it, otherwise "name 2", "name 3", … before the extension. */
async function freeName(dir, name) {
  const m = /^(.*?)((?:\.proof)?\.[^.]+)$/.exec(name) ?? [null, name, ''];
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${m[1]} ${n}${m[2]}`;
    try { await fs.access(path.join(dir, candidate)); } catch { return candidate; }
  }
}

/** Creates a document in `dir`, never overwriting one. Returns its path. */
async function createFile(root, dir, name, text) {
  const at = mustBeInside(root, dir);
  const p = path.join(at, await freeName(at, cleanName(name)));
  await fs.writeFile(p, text, { encoding: 'utf8', flag: 'wx' });
  return p;
}

/** Renames a document within its folder. Refuses to replace another file. Returns the new path. */
async function renameFile(root, from, newName) {
  const src = mustBeInside(root, from);
  const ext = (/((?:\.proof)?\.[^.]+)$/.exec(path.basename(src)) ?? ['', '.proof.json'])[1];
  const dest = path.join(path.dirname(src), cleanName(newName, ext));
  if (dest === src) return src;
  let taken = true;
  try { await fs.access(dest); } catch { taken = false; }
  // a change of letter case names the same file on some systems
  if (taken && dest.toLowerCase() !== src.toLowerCase()) throw new Error(`There is already a file called ${path.basename(dest)}.`);
  await fs.rename(src, dest);
  return dest;
}

module.exports = { inside, mustBeInside, listFolder, cleanName, freeName, createFile, renameFile };
