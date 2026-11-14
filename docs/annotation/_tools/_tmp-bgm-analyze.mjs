import fs from 'node:fs';

const repo = 'D:/code/ZCode';
const rel = 'packages/desktop/src/main/browserView/browserGuestManager.ts';
const src = fs.readFileSync(`${repo}/${rel}`, 'utf8').split(/\r?\n/);
const uncovered = fs
  .readFileSync('D:/code/_annot_baseline/_tmp-bgm-uncovered.txt', 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((l) => {
    const [p, line, b, ...rest] = l.split('\t');
    return { line: Number(line), branch: b === 'B', text: rest.join('\t') };
  });

const isComment = (s) => /^\s*(\/\/|\/\*|\*)/.test(s);
const isCode = (s) => s.trim() !== '' && !isComment(s);

// 向上 0–2 个空行内是否有注释（与 commentAbove 同口径）
function commentAbove(lineNo) {
  let i = lineNo - 2; // 0-based index of line above
  let blanks = 0;
  while (i >= 0) {
    const t = src[i].trim();
    if (t === '') {
      blanks++;
      if (blanks > 2) return null;
      i--;
      continue;
    }
    return isComment(src[i]) ? { at: i + 1, text: src[i].trim() } : null;
  }
  return null;
}

// 所属函数：向上找最近的 ^  function/class 行
const outline = [];
src.forEach((s, idx) => {
  if (/^(export )?(async )?function |^(export )?class /.test(s)) outline.push({ line: idx + 1, name: s.trim().slice(0, 90) });
  else if (/^  (private |public )?(async )?[a-zA-Z_]+\(/.test(s) && !/;$/.test(s.trim()))
    outline.push({ line: idx + 1, name: '  ' + s.trim().slice(0, 80) });
});

function fnOf(lineNo) {
  let lo = 0;
  for (const o of outline) if (o.line <= lineNo) lo = o;
  return lo;
}

const buckets = new Map();
let withComment = 0;
for (const u of uncovered) {
  const f = fnOf(u.line);
  const key = `${f.line}\t${f.name}`;
  const b = buckets.get(key) ?? { n: 0, b: 0, c: 0, min: u.line, max: u.line, fn: f };
  b.n++;
  if (u.branch) b.b++;
  if (commentAbove(u.line)) {
    b.c++;
    withComment++;
  }
  b.max = u.line;
  buckets.set(key, b);
}

const rows = [...buckets.values()].sort((a, b) => b.n - a.n);
console.log(`uncovered=${uncovered.length} inFnWithCommentAbove=${withComment} (${((withComment / uncovered.length) * 100).toFixed(1)}%)`);
console.log(`buckets=${rows.length}`);
console.log('--- top 40 by uncovered count ---');
console.log('fnLine\tuncovered\tbranch\thasCommentAbove\trange\tname');
for (const r of rows.slice(0, 40)) {
  console.log(`${r.fn.line}\t${r.n}\t${r.b}\t${r.c}\t${r.min}-${r.max}\t${r.fn.name}`);
}

// 按 500 行区间看整体分布
const seg = new Map();
for (const u of uncovered) {
  const k = Math.floor((u.line - 1) / 500) * 500 + 1;
  const s = seg.get(k) ?? { n: 0, c: 0 };
  s.n++;
  if (commentAbove(u.line)) s.c++;
  seg.set(k, s);
}
console.log('--- by 500-line segment ---');
for (const [k, v] of [...seg.entries()].sort((a, b) => a[0] - b[0])) console.log(`${k}-${k + 499}\t${v.n}\twithComment=${v.c}`);
