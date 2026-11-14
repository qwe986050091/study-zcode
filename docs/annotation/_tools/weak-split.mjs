import fs from 'node:fs';
import { execSync } from 'node:child_process';
const REPO = 'd:/code/opensource/valkey';
const BASE = 'c96bdec';
const q = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/quality-now.json', 'utf8'));

const diff = execSync(`git diff ${BASE} HEAD --unified=0 -- src`, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 28 });
const added = new Map();
const addedLines = new Map();
let cur = null;
for (const line of diff.split(/\r?\n/)) {
  if (line.startsWith('+++ b/')) { cur = line.slice(6); if (!added.has(cur)) { added.set(cur, new Set()); addedLines.set(cur, []); } continue; }
  if (line.startsWith('+++ ')) { cur = null; continue; }
  const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (m && cur) {
    const start = +m[1];
    const count = m[2] === undefined ? 1 : +m[2];
    for (let i = 0; i < count; i++) { added.get(cur).add(start + i); addedLines.get(cur).push(start + i); }
  }
}
const isComment = (text) => /^\s*(\/\*|\*|\/\/)/.test(text);

let own = 0, upstream = 0, addedComments = 0;
const upFiles = new Map();
const fileText = new Map();
for (const r of q.rows) {
  const full = `${REPO}/${r.path}`;
  const text = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').split('\n') : [];
  fileText.set(r.path, text);
  for (const ln of addedLines.get(r.path) || []) if (isComment(text[ln - 1] || '')) addedComments++;
  const set = added.get(r.path);
  for (const w of r.weakLines || []) {
    if (set && set.has(w.line)) own++;
    else {
      upstream++;
      if (!upFiles.has(r.path)) upFiles.set(r.path, []);
      upFiles.get(r.path).push({ line: w.line, reasons: w.reasons, content: w.content });
    }
  }
}
const list = [...upFiles.entries()].sort((a, b) => b[1].length - a[1].length)
  .map(([file, items]) => ({ file, count: items.length, items }));
const out = { generatedFrom: 'quality-now.json', base: BASE, totalWeak: own + upstream, ownWeak: own, ownWeakRate: addedComments ? own / addedComments * 100 : null, addedCommentLines: addedComments, upstreamWeak: upstream, files: list };
fs.writeFileSync('d:/code/_annot_baseline/weak-exemptions.json', JSON.stringify(out, null, 1));

const esc = (s) => String(s).replace(/\|/g, '\\|');
const md = [];
md.push('# 上游原有 weak 豁免清单');
md.push('');
md.push(`- 基线：\`${BASE}\`；对比：\`HEAD\`；数据源：\`deep-quality.mjs\` 全仓扫描（\`quality-now.json\`）。`);
md.push(`- 判定：weak 行号落在 \`git diff ${BASE} HEAD -U0\` 的新增行集合内即为「自有新增」，否则为「上游原有」。`);
md.push(`- 合计：weak ${own + upstream} 行 = 自有新增 ${own} 行 + 上游原有 ${upstream} 行（${list.length} 个文件）。`);
md.push(`- 自有新增 weak 率 = ${own} / ${addedComments} 新增注释行 = ${out.ownWeakRate.toFixed(2)}%；上游部分自此豁免，不计入自有质量数字。`);
md.push('- 行号随文件改动会漂移；重定位以「内容」列原文为准。');
md.push('');
md.push('| 文件 | 行号 | 原因 | 内容 |');
md.push('| --- | ---: | --- | --- |');
for (const f of list) for (const it of f.items) md.push(`| ${f.file} | ${it.line} | ${esc(it.reasons.join('、'))} | ${esc(it.content)} |`);
fs.writeFileSync('d:/code/opensource/valkey/docs/annotation/weak-exemptions.md', md.join('\n') + '\n');
console.log(`weak total=${own + upstream} own=${own} upstream=${upstream} addedComments=${addedComments} ownRate=${out.ownWeakRate.toFixed(2)}% files=${list.length}`);
