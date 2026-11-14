import fs from 'node:fs';

const file = 'crates/uv-auth/src/middleware.rs';
const items = [];
const add = (anchor, lines) => items.push({ anchor, lines });

add('let wrong_username = "wronguser";', [
  '错误的用户名用于验证文本存储不会模糊匹配到唯一记录。',
]);
add('let username = "testuser";', [
  '这组测试使用与前面不同的用户名，避免依赖其他用例的缓存。',
]);
add('// Both servers do not work without a username', [
  '两个索引都要求用户名，因此匿名请求应当全部 401。',
]);
add('// Test with the URL format `:password@host` (empty username, password present)', [
  '空用户名加密码是 token 认证的常见写法，需要被当作完整凭据。',
]);
add('assert!(server', [
  '断言没有任何请求到达服务端，证明失败发生在发送之前。',
]);
add('let url_with_username = format!(', [
  '手工拼接带用户名的 URL，保留 scheme、主机与端口。',
]);
add('let url_with_wrong_username = format!(', [
  '同样的拼接方式换成错误用户名，作为对照组。',
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
fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6e-11.json', JSON.stringify([{ file, items: resolved }], null, 2));
console.log('items', resolved.length, 'lines', resolved.reduce((n, i) => n + i.lines.length, 0));
