// 精确分类 10,094 个产品未覆盖单元：A=字符串内不可插入，B=机械重复，C=可注释产品代码。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { linesInsideStrings } = await import(pathToFileURL('d:/code/_annot_baseline/uv-string-spans.mjs').href);
const { testLineSet } = await import(pathToFileURL('d:/code/_annot_baseline/uv-test-blocks.mjs').href);

const [jsonPath, repoRoot] = process.argv.slice(2);
const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).rows;

function testBoundary(lines) {
  let boundary = null;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[cfg\(.*\btest\b.*\)\]\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j <= Math.min(i + 200, lines.length - 1); j++) {
      const t = lines[j].trim();
      if (/^#\[/.test(t) || t === '' || t.startsWith('//')) continue;
      if (/^(pub\s+)?mod\s+\w+\s*\{\s*$/.test(t) || /^(pub\s+)?mod\s+\w+\s*;/.test(t)) boundary = j + 1;
      break;
    }
    if (boundary !== null) break;
  }
  return boundary;
}
const skeleton = (text) => {
  let s = String(text);
  s = s.replace(/r#*"[^"]*"#*/g, 'STR').replace(/"(?:[^"\\]|\\.)*"/g, 'STR');
  s = s.replace(/\b\d[\d_.]*\b/g, 'NUM');
  s = s.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, 'ID');
  return s.replace(/\s+/g, ' ').trim();
};
const CONTROL = /\b(if|else|match|for|while|loop|return|break|continue|await|unsafe)\b|\?|=>|panic!|unwrap|expect\(|Err\(|Ok\(|map_err/;

const all = [];
const globalSkel = new Map();
for (const r of rows) {
  const rel = r.path.split(path.sep).join('/');
  const abs = path.join(repoRoot, rel.split('/').join(path.sep));
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  const inTestSet = testLineSet(lines);
  const b = inTestSet.size ? Math.min(...inTestSet) : null;
  const insideArr = linesInsideStrings(text.replace(/\r\n/g, '\n'));
  const inside = new Set(insideArr.map((v, i) => (v ? i + 1 : 0)).filter(Boolean));
  const m = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (inTestSet.has(i + 1)) continue;
    const t = lines[i].trim();
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    const sk = skeleton(t);
    m.set(sk, (m.get(sk) || 0) + 1);
    if (!globalSkel.has(sk)) globalSkel.set(sk, new Set());
    globalSkel.get(sk).add(rel);
  }
  for (const u of r.uncoveredUnits ?? []) {
    if (inTestSet.has(u.line)) continue;
    const sk = skeleton(u.text);
    const d1 = (m.get(sk) || 0) >= 2;
    const d2 = (globalSkel.get(sk)?.size || 0) >= 3;
    const ctrl = CONTROL.test(u.text);
    const inStr = inside.has(u.line);
    let cat;
    if (inStr) cat = 'A';
    else if ((d1 || d2) && !ctrl) cat = 'B';
    else cat = 'C';
    all.push({ file: rel, line: u.line, cat, text: u.text });
  }
}

const byCat = {};
for (const u of all) byCat[u.cat] = (byCat[u.cat] || 0) + 1;
console.log(`TOTAL=${all.length} A_inString=${byCat.A || 0} B_dup=${byCat.B || 0} C_annotatable=${byCat.C || 0}`);
const byFile = {};
for (const u of all) {
  if (u.cat !== 'C') continue;
  byFile[u.file] = (byFile[u.file] || 0) + 1;
}
const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]);
console.log(`C files=${top.length}`);
for (const [f, n] of top.slice(0, 20)) console.log(`${n}\t${f}`);
fs.writeFileSync('d:/code/_annot_baseline/uv-rework/audit-c.json', JSON.stringify(all, null, 0), 'utf8');
