// 重建「改写前」基线：把某批次的 spec 重新插回该批次的 orig 快照，得到注释已插入、尚未改写的状态。
// 用途：改写验证需要一个 pre-rewrite 基线；插入是确定性的，重放即可精确复原。
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'D:/code/_annot_baseline';
const srcBatch = process.argv[2];
const destBatch = process.argv[3];
const specs = process.argv.slice(4);
if (!srcBatch || !destBatch || !specs.length) {
  console.error('usage: node _replay_pre.mjs <srcBatch> <destBatch> <spec.json...>');
  process.exit(2);
}

const srcDir = path.join(BASE, srcBatch, 'orig');
const destDir = path.join(BASE, destBatch, 'orig');
fs.mkdirSync(destDir, { recursive: true });

const targets = [];
for (const specPath of specs) {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  for (const f of spec.files) {
    if (targets.some((t) => t.file === f.file)) {
      const t = targets.find((x) => x.file === f.file);
      t.items.push(...f.items);
    } else {
      targets.push({ file: f.file, items: [...f.items] });
    }
  }
}

for (const f of targets) {
  const srcAbs = path.join(srcDir, f.file);
  if (!fs.existsSync(srcAbs)) {
    console.error(`[FAIL] ${f.file}: missing in ${srcBatch}/orig`);
    process.exit(1);
  }
  const raw = fs.readFileSync(srcAbs, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const plan = [];
  for (const item of f.items) {
    const anchor = String(item.anchor ?? '').trim();
    const hits = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim() === anchor) hits.push(i);
    const nth = item.nth || 1;
    if (hits.length < nth || (!item.nth && hits.length !== 1)) {
      console.error(`[FAIL] ${f.file}: anchor hit ${hits.length} (nth=${nth}): ${anchor}`);
      process.exit(1);
    }
    const idx = hits[nth - 1];
    const out = item.raw
      ? item.raw
      : item.lines.map((t) => {
          const indent = /^[ \t]*/.exec(lines[idx])[0];
          return t === ''
            ? indent + '//'
            : indent + (String(t).trimStart().startsWith('//') ? String(t).trimStart() : '// ' + t);
        });
    plan.push({ idx, out });
  }
  plan.sort((a, b) => b.idx - a.idx);
  const next = lines.slice();
  for (const p of plan) next.splice(p.idx, 0, ...p.out);
  const destAbs = path.join(destDir, f.file);
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.writeFileSync(destAbs, next.join(eol));
  console.log(`[replay] ${f.file}: ${plan.length} blocks`);
}

fs.writeFileSync(
  path.join(BASE, destBatch, '_files.txt'),
  targets.map((t) => t.file).join('\n') + '\n',
  'utf8',
);
console.log(`TOTAL files=${targets.length}`);
