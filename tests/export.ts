import { writeFileSync } from 'fs';
import { sampleDoc } from '../src/model/sample';
import { exportTypst } from '../src/export/typst';
import { exportLatex } from '../src/export/latex';
const d = sampleDoc();
const t = exportTypst(d); const l = exportLatex(d);
const dir = process.argv[2];
writeFileSync(dir + '/main.typ', t.source); writeFileSync(dir + '/main.tex', l.source);
console.log('typst warnings', t.warnings, 'latex warnings', l.warnings);
