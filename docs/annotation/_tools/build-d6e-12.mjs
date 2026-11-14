import fs from 'node:fs';

const file = 'crates/uv-auth/src/middleware.rs';
const items = [];
const add = (anchor, lines) => items.push({ anchor, lines });

add('use std::sync::atomic::{AtomicUsize, Ordering};', [
  '原子计数与内存序：断言前用 SeqCst 读取，保证看到其他任务写入的值。',
]);
add('use http::Method;', [
  'Method 用于构造 wiremock 的匹配器，限定只拦截 GET。',
]);
add('use wiremock::matchers::{basic_auth, method, path_regex};', [
  'path_regex 是前缀路由的关键：同一台服务端承载多个索引前缀。',
]);
add('use wiremock::{Mock, MockServer, ResponseTemplate};', [
  'MockServer 绑定随机端口，因此 realm 会随测试实例变化而不冲突。',
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
fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6e-12.json', JSON.stringify([{ file, items: resolved }], null, 2));
console.log('items', resolved.length, 'lines', resolved.reduce((n, i) => n + i.lines.length, 0));
