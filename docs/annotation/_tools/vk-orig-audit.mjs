// 审计所有批次 orig 是否等于 git show HEAD:
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const base = 'd:/code/_annot_baseline';
const repo = 'd:/code/opensource/valkey';
const norm = (s) => s.replace(/\r\n/g, '\n');
const rows = [];
let total = 0;
let equal = 0;
for (const d of fs.readdirSync(base)) {
  const od = path.join(base, d, 'orig');
  if (!fs.existsSync(od)) continue;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!/\.(c|h)$/.test(e.name)) continue;
      total++;
      const rel = path.relative(od, f).split(path.sep).join('/');
      let head;
      try {
        head = norm(execSync(`git show HEAD:${rel}`, { cwd: repo, maxBuffer: 1e8 }).toString());
      } catch {
        rows.push(`${d}/${rel}\tMISSING-IN-HEAD`);
        continue;
      }
      const cur = norm(fs.readFileSync(f, 'utf8'));
      if (cur === head) { equal++; continue; }
      const a = head.split('\n');
      const b = cur.split('\n');
      const bs = new Set(b);
      const as = new Set(a);
      rows.push(`${d}/${rel}\torigOnly=${a.filter((x) => !bs.has(x)).length}\theadOnly=${b.filter((x) => !as.has(x)).length}`);
    }
  };
  walk(od);
}
console.log(`total=${total} equalHEAD=${equal} snapshot=${rows.length}`);
console.log(rows.join('\n'));
