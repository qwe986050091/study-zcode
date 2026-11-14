// 全仓脏文件分类：纯注释改动 / 含代码改动 / 未跟踪文档 / 未跟踪其它。
// 输出 JSON + 三份清单文件，供安全快照提交使用。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2];
const outDir = process.argv[3];
const run = (args, opts = {}) =>
  execFileSync('git', ['-C', repo, ...args], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8', ...opts });

const status = run(['status', '--porcelain']).split(/\r?\n/).filter(Boolean);
const tracked = [];
const untracked = [];
for (const line of status) {
  const code = line.slice(0, 2);
  const p = line.slice(3).trim().replace(/^"|"$/g, '');
  if (code.includes('?')) untracked.push(p);
  else tracked.push({ p, code });
}

// 一次性拿全仓 -U0 diff，按文件切分
const diff = run(['diff', '-U0', '--no-color', '--no-ext-diff']);
const byFile = new Map();
let cur = null;
for (const line of diff.split(/\r?\n/)) {
  if (line.startsWith('diff --git ')) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    cur = m ? m[2] : null;
    if (cur) byFile.set(cur, { added: 0, deleted: 0, nonCommentAdded: 0, nonCommentDeleted: 0, samples: [] });
    continue;
  }
  if (!cur) continue;
  const rec = byFile.get(cur);
  if (line.startsWith('+') && !line.startsWith('+++')) {
    rec.added++;
    const t = line.slice(1).trim();
    const isComment = t === '' || /^(\/\/|\/\*|\*|\*\/|#|<!--|-->|;)/.test(t);
    if (!isComment) {
      rec.nonCommentAdded++;
      if (rec.samples.length < 2) rec.samples.push(t.slice(0, 100));
    }
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    rec.deleted++;
    const t = line.slice(1).trim();
    const isComment = t === '' || /^(\/\/|\/\*|\*|\*\/|#|<!--|-->|;)/.test(t);
    if (!isComment) rec.nonCommentDeleted++;
  }
}

const annot = [];
const code = [];
const unknown = [];
for (const { p } of tracked) {
  const r = byFile.get(p);
  if (!r) {
    unknown.push({ file: p, reason: 'no-diff' });
    continue;
  }
  const isAnnotation = r.deleted === 0 && r.nonCommentAdded === 0;
  const entry = { file: p, added: r.added, deleted: r.deleted, nonCommentAdded: r.nonCommentAdded, nonCommentDeleted: r.nonCommentDeleted };
  if (isAnnotation) annot.push(entry);
  else code.push({ ...entry, samples: r.samples });
}

const docUntracked = untracked.filter((p) => p.startsWith('docs/annotation/'));
const otherUntracked = untracked.filter((p) => !p.startsWith('docs/annotation/'));

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(`${outDir}/_annot-files.txt`, annot.map((x) => x.file).join('\n') + '\n');
fs.writeFileSync(`${outDir}/_code-files.txt`, code.map((x) => x.file).join('\n') + '\n');
fs.writeFileSync(`${outDir}/_untracked-docs.txt`, docUntracked.join('\n') + '\n');
fs.writeFileSync(`${outDir}/_untracked-other.txt`, otherUntracked.join('\n') + '\n');
fs.writeFileSync(
  `${outDir}/_classify.json`,
  JSON.stringify({ annot, code, unknown, docUntracked, otherUntracked }, null, 2),
);

const sum = (arr, k) => arr.reduce((s, x) => s + x[k], 0);
console.log(`TRACKED ${tracked.length} UNTRACKED ${untracked.length}`);
console.log(`ANNOT-FILES ${annot.length} ANNOT-ADDED ${sum(annot, 'added')} ANNOT-DELETED ${sum(annot, 'deleted')}`);
console.log(`CODE-FILES ${code.length} CODE-ADDED ${sum(code, 'added')} CODE-DELETED ${sum(code, 'deleted')}`);
console.log(`UNTRACKED-DOCS ${docUntracked.length} UNTRACKED-OTHER ${otherUntracked.length} UNKNOWN ${unknown.length}`);
console.log('CODE-SAMPLE');
for (const c of code.slice(0, 30)) console.log(`  ${c.file} +${c.added}/-${c.deleted} nonComment+${c.nonCommentAdded} :: ${(c.samples || []).join(' | ')}`);
console.log('UNKNOWN-SAMPLE');
for (const u of unknown.slice(0, 20)) console.log(`  ${u.file} (${u.reason})`);
console.log('UNTRACKED-OTHER');
for (const u of otherUntracked.slice(0, 30)) console.log(`  ${u}`);
