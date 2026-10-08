import { texToTypst } from '../src/latex/toTypst';
const xs = process.argv.slice(2);
for (const x of xs) { const r = texToTypst(x); console.log(JSON.stringify({src: x, out: r.code, w: r.warnings})); }
