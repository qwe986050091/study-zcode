import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync('ZC-measure-all.json', 'utf8'));
const files = process.argv.slice(2);
const arr = Array.isArray(data) ? data : (data.files || data.rows || []);
const map = new Map(arr.map((r) => [r.path || r.file, r]));
for (const f of files) {
  const r = map.get(f) || map.get('D:/code/ZCode/' + f);
  if (!r) { console.log('MISSING ' + f); continue; }
  console.log(f, '| total=' + (r.total ?? r.lines), 'code=' + r.code, 'comment=' + r.comment, 'density=' + r.density, 'need314=' + (Math.round(r.code * 0.314) - r.comment));
}
