import fs from 'node:fs';
const b = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/_rb_deep_b2_plan.json', 'utf8'));
const a = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/_rb_deep_b2_after.json', 'utf8'));
const m = new Map(b.rows.map((r) => [r.path, r]));
let bt = 0, bc = 0, at = 0, ac = 0, an = 0, code = 0;
const rows = [];
for (const r of a.rows.slice().sort((x, y) => x.path.localeCompare(y.path))) {
  const x = m.get(r.path);
  bt += x.total; bc += x.comment;
  at += r.total; ac += r.comment; an += r.newComments; code += r.code;
  rows.push(`| \`${r.path}\` | ${x.total} | ${x.comment} | ${((x.comment / x.total) * 100).toFixed(2)}% | ${r.total} | ${r.comment} | ${((r.comment / r.total) * 100).toFixed(2)}% | ${r.codeRatio.toFixed(2)}% | +${r.newComments} |`);
}
console.log(rows.join('\n'));
console.log('TOTALS', bt, bc, ((bc / bt) * 100).toFixed(2), at, ac, ((ac / at) * 100).toFixed(2), an, code);
