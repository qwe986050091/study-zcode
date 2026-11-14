// 检测同一注释块内的近重复行（char-bigram Jaccard），并标注该行是否存在于 HEAD。
import fs from 'node:fs';

const ROOT = 'D:/code/ZCode';
const rel = process.argv[2] || 'packages/desktop/src/main/index.ts';
const cur = fs.readFileSync(`${ROOT}/${rel}`, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const headRaw = fs.readFileSync(`D:/code/_annot_baseline/ZC-lc52/head/${rel}`, 'utf8').replace(/^\uFEFF/, '');
const headSet = new Set(headRaw.split(/\r?\n/).map((l) => l.trim()));

const body = (l) => l.trim().replace(/^\/\/\s?/, '').trim();
const bigrams = (s) => {
  const out = new Set();
  const t = s.replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
};
const sim = (a, b) => {
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 1 : inter / union;
};

let block = [];
const flush = () => {
  for (let i = 0; i < block.length; i++) {
    for (let j = i + 1; j < block.length; j++) {
      const s = sim(body(block[i].text), body(block[j].text));
      if (s >= 0.5) {
        console.log(`${block[i].ln}\t${block[j].ln}\t${s.toFixed(2)}\tOWN=${!headSet.has(block[i].text.trim())}/${!headSet.has(block[j].text.trim())}\n  A: ${body(block[i].text)}\n  B: ${body(block[j].text)}`);
      }
    }
  }
  block = [];
};
let lastIndent = null;
for (let i = 0; i < cur.length; i++) {
  const t = cur[i].trim();
  if (t.startsWith('//')) {
    const ind = /^[ \t]*/.exec(cur[i])[0];
    if (lastIndent !== null && ind !== lastIndent) flush();
    lastIndent = ind;
    block.push({ ln: i + 1, text: cur[i] });
  } else {
    flush();
    lastIndent = null;
  }
}
flush();


