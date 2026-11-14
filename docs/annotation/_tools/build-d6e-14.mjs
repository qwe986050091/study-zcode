import fs from 'node:fs';

const file = 'crates/uv-auth/src/middleware.rs';
const items = [];
const add = (anchor, lines) => items.push({ anchor, lines });

add('use reqwest::Client;', [
  '测试里直接使用 reqwest::Client 构造请求，中间件通过 ClientBuilder 挂载。',
]);
add('use tempfile::NamedTempFile;', [
  '临时文件在测试结束时自动删除，避免污染用户主目录。',
]);
add('use crate::credentials::Password;', [
  'Password 用于断言解析出的密码，也用于构造带密码的测试凭据。',
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
fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6e-14.json', JSON.stringify([{ file, items: resolved }], null, 2));
console.log('items', resolved.length, 'lines', resolved.reduce((n, i) => n + i.lines.length, 0));
