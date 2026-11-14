// 4.40 收尾：① 生成 203 处 A 类总表（当前行号）；② 按每 10 处取 1 抽取 20 处做「总述是否描述该字符串」抽检。
import fs from 'node:fs';
import path from 'node:path';

const plan = JSON.parse(fs.readFileSync('d:/code/_annot_baseline/uv-rework/a-plan.json', 'utf8'));
const root = 'd:/code/opensource/uv';
const byFile = new Map();
for (const e of plan) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}
const NEWLINES = new Map([
  ['crates/uv-distribution-types/src/index.rs', [875]],
  ['crates/uv-netrc/src/netrc.rs', [589, 806, 825, 844]],
  ['crates/uv-pep440/src/version.rs', [3339, 3378]],
  ['crates/uv-python-discovery/src/project.rs', [409]],
  ['crates/uv-workspace/src/pyproject.rs', [635, 744, 800, 838, 907]],
  ['crates/uv-lock/src/lock/mod.rs', [14575]],
]);

const rows = [];
for (const [file, entries] of [...byFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  entries.sort((a, b) => a.startLine - b.startLine);
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/);
  const ins = entries.filter((e) => !e.hasComment);
  // 4.40 收尾时在 lock/mod.rs 的 ConflictingExtra 上方补的一行（不在 a-plan 里）
  const extra = file.endsWith('uv-lock/src/lock/mod.rs') ? [14575] : [];
  for (const e of entries) {
    const off = ins.filter((x) => x.insertAt < e.startLine).length + extra.filter((x) => x < e.startLine).length;
    const cur = e.startLine + off;
    const got = (lines[cur - 1] ?? '').trim();
    const want = e.firstText.trim().slice(0, 16);
    if (!got.startsWith(want)) {
      rows.push({ file, ok: false, note: `MISMATCH L${cur}: ${got.slice(0, 40)} vs ${want}` });
      continue;
    }
    const insAt = e.insertAt + ins.filter((x) => x.insertAt < e.insertAt).length + extra.filter((x) => x <= e.insertAt).length;
    let commentLine = null;
    if (!e.hasComment) {
      commentLine = insAt; // 本次插入的注释就占在原语句起始行
    } else {
      // 紧邻注释块的块首：从语句上一行起向上吃连续的 // 或 /// 行
      let top = insAt - 1;
      while (top > 1 && lines[top - 2].trim().startsWith('//')) top--;
      if (lines[top - 1] && lines[top - 1].trim().startsWith('//')) commentLine = top;
    }
    const isNew = commentLine !== null && (NEWLINES.get(file) ?? []).includes(commentLine);
    rows.push({
      file,
      start: cur,
      end: cur + e.count - 1,
      count: e.count,
      commentLine,
      commentText: commentLine ? lines[commentLine - 1].trim() : null,
      isNew,
      firstText: e.firstText.trim().slice(0, 60),
      ok: true,
    });
  }
}

const bad = rows.filter((r) => !r.ok);
console.log('rows=' + rows.length + ' mismatch=' + bad.length);
for (const b of bad) console.log('BAD ' + b.file + ' ' + b.note);

const md = [];
md.push('| # | 文件 | 区间 | 行数 | 总述行号 | 来源 | 总述（首行） |');
md.push('| --- | --- | --- | --- | --- | --- | --- |');
rows.forEach((r, i) => {
  md.push(
    `| ${i + 1} | \`${r.file.replace('crates/', '')}\` | ${r.start}–${r.end} | ${r.count} | ${r.commentLine ?? '—'} | ${r.isNew ? '本次新增' : '既有'} | ${(r.commentText ?? '—').replace(/\|/g, '\\|').slice(0, 90)} |`
  );
});
fs.writeFileSync('d:/code/_annot_baseline/uv-rework/a-table-203.md', md.join('\n') + '\n', 'utf8');
console.log('new=' + rows.filter((r) => r.isNew).length + ' existing=' + rows.filter((r) => r.commentLine && !r.isNew).length + ' none=' + rows.filter((r) => !r.commentLine).length);

const sampleIdx = [];
for (let i = 0; i < 20; i++) sampleIdx.push(i * 10);
const out = [];
out.push('sample of ' + rows.length);
for (const i of sampleIdx) {
  const r = rows[i];
  out.push('');
  out.push(`#${i} ${r.file}:${r.start}-${r.end} (${r.count} 行) 总述行=${r.commentLine} 来源=${r.isNew ? '新增' : '既有'}`);
  out.push('  注释: ' + (r.commentText ?? '(none)'));
  out.push('  字符串首行: ' + r.firstText);
}
fs.writeFileSync('d:/code/_annot_baseline/uv-rework/a-sample20.txt', out.join('\n') + '\n', 'utf8');
