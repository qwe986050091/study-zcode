// 预检 spec 的锚点/唯一性/注释行合法性，不写文件。用法：node check-spec.mjs <spec.json> <repoDir>
import fs from 'node:fs';
import path from 'node:path';
const specPath = process.argv[2];
const repo = process.argv[3] || 'D:/code/opensource/mcp-python-sdk';
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8').replace(/^\uFEFF/, ''));
let bad = 0;
let total = 0;
for (const e of spec) {
  const abs = path.join(repo, e.rel);
  if (!fs.existsSync(abs)) {
    console.log('MISSING FILE ' + e.rel);
    bad++;
    continue;
  }
  const rows = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  const isPy = e.rel.endsWith('.py');
  const prefix = isPy ? '#' : '//';
  for (const raw of e.lines || []) {
    total++;
    const s = String(raw).trim();
    if (!s.startsWith(prefix)) {
      console.log('NOT COMMENT: ' + e.rel + ' :: ' + s.slice(0, 100));
      bad++;
    }
    if (s.includes('*/')) {
      console.log('STAR-SLASH: ' + e.rel + ' :: ' + s.slice(0, 100));
      bad++;
    }
  }
  if (e.mode === 'bof' || e.mode === 'eof') continue;
  const want = String(e.anchor ?? '').trim();
  const hits = rows.filter((r) => r.trim() === want).length;
  const occ = e.occ ?? 1;
  if (hits < occ) {
    console.log(`ANCHOR MISS (hits=${hits} want=${occ}): ${e.rel} :: ${want.slice(0, 100)}`);
    bad++;
  } else if (hits > 1 && e.occ == null) {
    console.log(`ANCHOR DUP (hits=${hits}): ${e.rel} :: ${want.slice(0, 100)}`);
    bad++;
  }
}
console.log(`CHECK blocks=${spec.length} lines=${total} bad=${bad}`);
process.exit(bad ? 1 : 0);
