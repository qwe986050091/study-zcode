import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = 'D:/code/opensource/drizzle-orm';
const ROOTS = ['drizzle-orm/src', 'drizzle-kit/src'];
const KEYWORDS = ['都', '全部', '一律', '始终', '从不', '必然', '只会', '唯一', '没有一处', '只有', '仅有'];
const keyOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
};
const all = [];
for (const root of ROOTS) {
  for (const abs of walk(path.join(REPO, root))) {
    const rel = path.relative(REPO, abs).replace(/\\/g, '/');
    const lines = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*\/\/(.*)$/.exec(lines[i]);
      if (!m) continue;
      const text = m[1].trim();
      if (!/[\u4e00-\u9fff]/.test(text)) continue;
      for (const seg of text.split(/(?<=[。；])/).map((s) => s.trim()).filter(Boolean)) {
        const hits = KEYWORDS.filter((k) => seg.includes(k));
        if (!hits.length) continue;
        all.push({ key: keyOf(seg), file: rel, line: i + 1, kw: hits[0], seg });
      }
    }
  }
}
const audited = new Set();
for (const line of fs.readFileSync(path.join(REPO, 'docs/annotation/DZ-claim-ledger.md'), 'utf8').split(/\r?\n/)) {
  const m = /^\|\s*`([0-9a-f]{8})`\s*\|/.exec(line);
  if (m) audited.add(m[1]);
}
const pick = (kw) => all.filter((c) => c.kw === kw && !audited.has(c.key));
fs.writeFileSync('R52-layer-biran.json', JSON.stringify(pick('必然'), null, 2), 'utf8');
fs.writeFileSync('R52-layer-yilv.json', JSON.stringify(pick('一律'), null, 2), 'utf8');
console.log('必然', pick('必然').length, '一律', pick('一律').length);
