import fs from 'node:fs';
const p = 'D:/code/ZCode/packages/services/src/task-groups/repository.ts';
const targets = [
  '// 插入时 sort_order 先写 0，真正的顺序由紧随其后的 writeOrder 覆盖：',
  '// 若在这里算位置，需要先读一次目标组全部成员，与后续写序重复且更容易漏算。',
];
let text = fs.readFileSync(p, 'utf8');
const crlf = text.includes('\r\n');
const lines = text.split(/\r?\n/);
for (const t of targets) {
  const hits = [];
  lines.forEach((l, i) => { if (l === t) hits.push(i); });
  if (hits.length !== 1) { console.error('BAD', t, hits.length); process.exit(1); }
  lines.splice(hits[0], 1);
}
fs.writeFileSync(p, lines.join(crlf ? '\r\n' : '\n'));
console.log('REMOVED 2 lines inside template literal');
