// 一次性质检脚本：扫描 git diff 中新增的注释行，找出「连续 >=3 行、短句、无标识符」的水注水段落。
// 只读，不修改任何文件。
import { execSync } from 'node:child_process';

const REPO = 'd:/code/opensource/mcp-sdk';
const EXCLUDE = new Set(['STEP', 'INV', 'RFC']); // 结构性标记，不算代码标识符
const LATIN = /[A-Za-z_][A-Za-z0-9_]*/g;

function tokens(text) {
  return (text.match(LATIN) ?? []).filter(t => !EXCLUDE.has(t));
}

const diff = execSync(`git -C "${REPO}" diff --unified=0`, { maxBuffer: 1 << 28 }).toString('utf8');
const rawLines = diff.split(/\r?\n/);

// 收集「新增的连续注释块」：每块内部行号连续，且中间没有代码行
const blocks = [];
let file = null;
let newLine = 0;
let cur = [];
let lastNo = -10;

function flush() {
  if (cur.length) blocks.push({ file, lines: cur.slice() });
  cur = [];
}

for (const raw of rawLines) {
  if (raw.startsWith('+++ b/')) { flush(); file = raw.slice(6); lastNo = -10; continue; }
  if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff --git') || raw.startsWith('index ')) { flush(); continue; }
  const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (hunk) { flush(); newLine = Number(hunk[1]); lastNo = -10; continue; }
  if (raw.startsWith('+')) {
    const text = raw.slice(1);
    if (/^\s*\/\//.test(text)) {
      const content = text.replace(/^\s*\/\//, ' ').trim();
      if (lastNo === newLine - 1) cur.push({ lineNo: newLine, content, len: [...content].length, tok: tokens(content) });
      else { flush(); cur = [{ lineNo: newLine, content, len: [...content].length, tok: tokens(content) }]; }
      lastNo = newLine;
    } else { flush(); lastNo = -10; }
    newLine++;
    continue;
  }
  if (raw.startsWith('-')) { flush(); lastNo = -10; continue; }
  if (raw.startsWith(' ')) { flush(); lastNo = -10; newLine++; continue; }
}
flush();

const added = blocks.reduce((a, b) => a + b.lines.length, 0);
console.log(`新增注释行: ${added}，连续块: ${blocks.length}`);

function scan(name, pred) {
  const hits = [];
  for (const b of blocks) {
    let run = [];
    for (const l of b.lines) {
      if (pred(l)) run.push(l);
      else { if (run.length >= 3) hits.push({ file: b.file, lines: run }); run = []; }
    }
    if (run.length >= 3) hits.push({ file: b.file, lines: run });
  }
  const lines = hits.reduce((a, h) => a + h.lines.length, 0);
  console.log(`\n[${name}] 段=${hits.length} 行=${lines}`);
  const files = [...new Set(hits.map(h => h.file))];
  console.log(`涉及文件=${files.length}`);
  for (const h of hits) {
    console.log(`  ${h.file} L${h.lines[0].lineNo}~L${h.lines.at(-1).lineNo} (${h.lines.length}行)`);
    for (const l of h.lines) console.log(`    ${l.lineNo} | ${l.content} | len=${l.len} tok=${l.tok.join(',') || '-'}`);
  }
  return hits;
}

// A：用户原口径（<25 字且无 ASCII 标识符）
scan('A 严格：<25字 且 无标识符', l => l.len < 25 && l.tok.length === 0);
// B：放宽到 40 字、无标识符
scan('B 放宽：<40字 且 无标识符', l => l.len < 40 && l.tok.length === 0);
// C：只看「连续 3 行都短于 25 字」，不管标识符
scan('C 短句堆叠：<25字（不论标识符）', l => l.len < 25);
// D：短行——连续 3 行都短于 30 字（不论标识符）
scan('D 短行：<30字（不论标识符）', l => l.len < 30);

// E：排比式——连续 3 行首 2 字相同且都短于 30 字
{
  const hits = [];
  for (const b of blocks) {
    let run = [];
    for (const l of b.lines) {
      const key = [...l.content].slice(0, 2).join('');
      if (l.len < 30 && run.length && [...run[0].content].slice(0, 2).join('') === key) run.push(l);
      else { if (run.length >= 3) hits.push({ file: b.file, lines: run }); run = [l]; }
    }
    if (run.length >= 3) hits.push({ file: b.file, lines: run });
  }
  console.log(`\n[E 排比：首2字相同且<30字] 段=${hits.length} 行=${hits.reduce((a, h) => a + h.lines.length, 0)}`);
  for (const h of hits) {
    console.log(`  ${h.file} L${h.lines[0].lineNo}~L${h.lines.at(-1).lineNo} (${h.lines.length}行)`);
    for (const l of h.lines) console.log(`    ${l.lineNo} | ${l.content} | len=${l.len}`);
  }
}

// 自检：用用户给的反例验证判定器确实能命中
{
  const fake = [
    { lineNo: 1, content: '主循环只读写该对象。', len: 10, tok: [] },
    { lineNo: 2, content: '历史借用只读快照。', len: 9, tok: [] },
    { lineNo: 3, content: '后续由显式提交推进。', len: 10, tok: [] },
  ];
  const hit = fake.every(l => l.len < 25 && l.tok.length === 0);
  console.log(`\n[自检] 用户反例是否命中 A 口径: ${hit ? '是（判定器有效）' : '否（判定器失效）'}`);
}

// 最差样例：按平均行长排序的连续块（>=3 行）
const ranked = blocks
  .filter(b => b.lines.length >= 3)
  .map(b => ({ ...b, avg: b.lines.reduce((s, l) => s + l.len, 0) / b.lines.length }))
  .sort((a, b) => a.avg - b.avg)
  .slice(0, 5);
console.log('\n[平均行长最短的 5 个连续块]');
for (const b of ranked) {
  console.log(`  ${b.file} L${b.lines[0].lineNo}~L${b.lines.at(-1).lineNo} avg=${b.avg.toFixed(1)}`);
  for (const l of b.lines) console.log(`    ${l.lineNo} | ${l.content} | len=${l.len}`);
}
