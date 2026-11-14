// 扫描：新增注释行是否落在 raw string 内部；以及「属性/文档注释后紧跟普通注释」的相邻模式。
import fs from 'node:fs';

const base = process.argv[2];
const cur = process.argv[3];

function rawInside(text) {
  const lines = text.split(/\r?\n/);
  const flags = new Array(lines.length).fill(false);
  let i = 0;
  let hashCount = -1;
  for (let ln = 0; ln < lines.length; ln++) {
    const s = lines[ln];
    for (let k = 0; k < s.length; k++) {
      if (hashCount >= 0) {
        flags[ln] = true;
        if (s[k] === '"') {
          let h = 0;
          while (s[k + 1 + h] === '#') h++;
          if (h === hashCount) {
            hashCount = -1;
            k += h;
          }
        }
        continue;
      }
      // 跳过普通字符串与字符字面量，避免把 r" 误认
      if (s[k] === '"' || s[k] === "'") {
        const q = s[k];
        k++;
        while (k < s.length) {
          if (s[k] === '\\') { k += 2; continue; }
          if (s[k] === q) break;
          k++;
        }
        continue;
      }
      // 行注释：本行剩余部分不再扫描
      if (s[k] === '/' && s[k + 1] === '/') break;
      if ((s[k] === 'r' || (s[k] === 'b' && s[k + 1] === 'r')) && (k === 0 || /[^\w]/.test(s[k - 1]))) {
        let j = s[k] === 'b' ? k + 2 : k + 1;
        let h = 0;
        while (s[j] === '#') { h++; j++; }
        if (s[j] === '"') {
          hashCount = h;
          k = j;
          continue;
        }
      }
    }
  }
  return flags;
}

const baseLines = fs.readFileSync(base, 'utf8').split(/\r?\n/);
const curLines = fs.readFileSync(cur, 'utf8').split(/\r?\n/);
const baseFlags = rawInside(fs.readFileSync(base, 'utf8'));
const curFlags = rawInside(fs.readFileSync(cur, 'utf8'));
let baseRawComments = 0;
for (let i = 0; i < baseLines.length; i++) if (baseFlags[i] && baseLines[i].trim().startsWith('//')) baseRawComments++;
let curRawComments = 0;
const bad = [];
for (let i = 0; i < curLines.length; i++) {
  if (curFlags[i] && curLines[i].trim().startsWith('//')) {
    curRawComments++;
    if (i < baseLines.length && baseLines[i] !== curLines[i]) bad.push(i + 1);
  }
}
let adj = 0;
for (let i = 1; i < curLines.length; i++) {
  const p = curLines[i - 1].trim();
  const c = curLines[i].trim();
  const isPlain = c.startsWith('//') && !c.startsWith('///') && !c.startsWith('//!');
  if (isPlain && (p.startsWith('#[') || p.startsWith('///'))) adj++;
}
console.log(`rawCommentsBase=${baseRawComments} rawCommentsCur=${curRawComments} rawInserted=${bad.length} adjacentViolations=${adj}`);
