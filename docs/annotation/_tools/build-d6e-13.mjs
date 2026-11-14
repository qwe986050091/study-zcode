import fs from 'node:fs';

const file = 'crates/uv-auth/src/middleware.rs';
const items = [];
const add = (anchor, lines) => items.push({ anchor, lines });

add('use reqwest_middleware::ClientBuilder;', [
  'ClientBuilder 允许在不同测试里挂载不同配置的中间件，其余代码完全一致。',
]);
add('use test_log::test;', [
  'test_log 的宏替换标准测试属性，让每个用例自动带上 tracing 订阅。',
]);

const lines = fs.readFileSync('d:\\code\\opensource\\uv\\' + file, 'utf8').split('\n');
const resolved = [];
for (const item of items) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '').trim() === item.anchor) hits.push(i);
  }
  if (hits.length !== 1) {
    console.error(`SKIP anchor x${hits.length}: ${item.anchor}`);
    continue;
  }
  resolved.push({ line: hits[0] + 1, anchor: lines[hits[0]].replace(/\r$/, ''), lines: item.lines });
}
fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6e-13.json', JSON.stringify([{ file, items: resolved }], null, 2));
console.log('items', resolved.length, 'lines', resolved.reduce((n, i) => n + i.lines.length, 0));
