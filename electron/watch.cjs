// Watches one document file and reports its text whenever the contents change.
// The directory is watched, not the file, so a save that replaces the file by
// rename is seen too.
const fs = require('node:fs');
const path = require('node:path');

/** Returns a function that stops watching; its `known(text)` records contents not to report (our own save). */
function watchFile(file, onChange) {
  const name = path.basename(file);
  let last = null;
  let timer;
  try { last = fs.readFileSync(file, 'utf8'); } catch { /* not there yet */ }
  const check = () => {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    if (text === last) return;
    last = text;
    onChange(text);
  };
  const watcher = fs.watch(path.dirname(file), (_event, changed) => {
    if (changed && changed !== name) return;
    clearTimeout(timer);
    timer = setTimeout(check, 100);
  });
  const stop = () => { clearTimeout(timer); watcher.close(); };
  stop.known = (text) => { last = text; };
  return stop;
}

module.exports = { watchFile };
