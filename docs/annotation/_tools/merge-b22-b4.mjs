// 合并 B22 中 desktopMainIpcRemote 的多轮 spec，便于重插时统一裁剪。
import fs from 'node:fs';

const files = ['b4', 'b4b', 'b4c', 'b4d', 'b4e', 'b4f'].map((s) => `D:/code/_annot_baseline/spec-b22-${s}.json`);
const target = 'packages/desktop/src/main/desktopMainIpcRemote.ts';
const items = [];
const seen = new Set();
for (const p of files) {
  const spec = JSON.parse(fs.readFileSync(p, 'utf8'));
  for (const f of spec.files) {
    if (f.file !== target) continue;
    for (const it of f.items) {
      const k = `${it.anchor}@@${it.nth || 1}`;
      if (seen.has(k)) { console.log(`DUP skipped: ${p} :: ${it.anchor}`); continue; }
      seen.add(k);
      items.push({ ...it, _src: p.split('spec-b22-')[1] });
    }
  }
}
let total = 0;
for (const it of items) {
  const n = it.raw ? it.raw.length : it.lines.length;
  total += n;
  console.log(`${String(n).padStart(3)}  ${it._src.padEnd(5)}  ${it.raw ? 'RAW' : it.anchor}`);
}
console.log(`ITEMS=${items.length} TOTAL=${total}`);
const out = {
  files: [{ file: target, items: items.map(({ _src, ...rest }) => rest) }],
};
fs.writeFileSync('D:/code/_annot_baseline/spec-b22-b4-merged.json', JSON.stringify(out, null, 2), 'utf8');
