// 把 24 个「工作区快照」基线重建为 git show HEAD: 导出（只动 orig/，不动源码）。
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const base = 'd:/code/_annot_baseline';
const repo = 'd:/code/opensource/valkey';
const norm = (s) => s.replace(/\r\n/g, '\n');
let rebuilt = 0;
for (const d of fs.readdirSync(base)) {
  const od = path.join(base, d, 'orig');
  if (!fs.existsSync(od)) continue;
  const walk = (p) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!/\.(c|h)$/.test(e.name)) continue;
      const rel = path.relative(od, f).split(path.sep).join('/');
      const head = norm(execSync(`git show HEAD:${rel}`, { cwd: repo, maxBuffer: 1e8 }).toString());
      if (norm(fs.readFileSync(f, 'utf8')) === head) continue;
      fs.writeFileSync(f, head, 'utf8');
      rebuilt++;
      console.log(`rebuilt ${d}/${rel}`);
    }
  };
  walk(od);
}
console.log(`rebuilt=${rebuilt}`);
