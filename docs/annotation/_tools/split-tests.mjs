// 按「pick 命中行的上一行是否为测试属性」拆分规格：
// 普通项原样输出到 mainOut，测试项上移一行输出到 testOut（注释落在属性之前）。
// 用法：node split-tests.mjs <in.json> <mainOut> <testOut>
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'd:\\code\\opensource\\uv';
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const mainOut = process.argv[3];
const testOut = process.argv[4];

const byFile = new Map();
for (const item of raw) {
  const rel = item.file;
  if (!byFile.has(rel)) byFile.set(rel, []);
  byFile.get(rel).push(item);
}

const mainSpec = [];
const testSpec = [];
const failures = [];

for (const [rel, items] of byFile) {
  const target = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const lines = fs.readFileSync(target, 'utf8').split('\n');
  const main = [];
  const tests = [];
  for (const item of items) {
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].replace(/\r$/, '').includes(item.pick)) hits.push(i);
    }
    let idx;
    if (item.nth !== undefined) {
      if (hits.length < item.nth) {
        failures.push(`${rel}: nth=${item.nth} hits=${hits.length} ${JSON.stringify(item.pick)}`);
        continue;
      }
      idx = hits[item.nth - 1];
    } else if (hits.length === 1) {
      idx = hits[0];
    } else {
      failures.push(`${rel}: ambiguous x${hits.length} ${JSON.stringify(item.pick)}`);
      continue;
    }
    const prev = (lines[idx - 1] ?? '').replace(/\r$/, '').trim();
    const isTest = prev.startsWith('#[test]') || prev.startsWith('#[tokio::test]');
    if (isTest) {
      const line = idx; // 上移一行，插到属性之前
      tests.push({ line, anchor: lines[line - 1].replace(/\r$/, ''), lines: item.lines });
    } else {
      main.push({ line: idx + 1, anchor: lines[idx].replace(/\r$/, ''), lines: item.lines });
    }
  }
  if (main.length) mainSpec.push({ file: rel, items: main });
  if (tests.length) testSpec.push({ file: rel, items: tests });
}

if (failures.length) {
  for (const f of failures) console.error('FAIL ' + f);
  process.exit(1);
}
fs.writeFileSync(mainOut, JSON.stringify(mainSpec, null, 2));
fs.writeFileSync(testOut, JSON.stringify(testSpec, null, 2));
const count = (s) => s.reduce((n, e) => n + e.items.length, 0);
console.log(`MAIN ${mainOut} items=${count(mainSpec)}`);
console.log(`TEST ${testOut} items=${count(testSpec)}`);
