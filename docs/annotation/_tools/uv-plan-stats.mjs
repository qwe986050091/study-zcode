import fs from 'node:fs';
import path from 'node:path';
const dirs = ['d:/code/_annot_baseline/uv-rework/backfill', 'd:/code/_annot_baseline/uv-rework/backfill2'];
for (const d of dirs) {
  let e = 0, l = 0, m = 0, files = 0;
  const walk = (p) => {
    for (const x of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, x.name);
      if (x.isDirectory()) { walk(q); continue; }
      if (!x.name.endsWith('.json')) continue;
      const j = JSON.parse(fs.readFileSync(q, 'utf8'));
      const ed = j.edits || [];
      if (!ed.length) continue;
      files++;
      for (const t of ed) {
        e++;
        const c = (t.comments || []).length;
        l += c;
        if (c > 1) m++;
      }
    }
  };
  walk(d);
  console.log(`${d.split('/').pop()} files=${files} edits=${e} lines=${l} multi=${m}`);
}
