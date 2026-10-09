// Prints the check report for a saved document as JSON, with the same
// arrangement of it the tracker tab shows under `view`:
//   npm run check -- path/to/document.json

import { readFileSync } from 'node:fs';
import { checkDoc } from './index';
import { trackerView } from './view';
import type { Doc } from '../model/types';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run check -- <document.json>');
  process.exit(2);
}
let doc: Doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`${file}: ${(e as Error).message}`);
  process.exit(2);
}
if (!doc || doc.version !== 1 || !Array.isArray(doc.blocks) || !Array.isArray(doc.snippets)) {
  console.error(`${file}: not a Proof Writer document`);
  process.exit(2);
}
const report = checkDoc(doc);
console.log(JSON.stringify({ ...report, view: trackerView(doc, report) }, null, 2));
