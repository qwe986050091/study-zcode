import fs from 'node:fs';

const file = 'crates/uv-requirements-txt/src/lib.rs';
const S = 477;
const items = [];
const add = (old, lines) => items.push({ line: old + S, lines });

add(1265, [
  '--no-binary 的说明符错误只展示原始值，不展开底层名称校验错误。',
]);
add(1268, [
  '--only-binary 与 --no-binary 的提示格式保持一致。',
]);
add(1271, [
  '未命名约束的错误不带位置：它通常来自嵌套文件，外层已经给出位置。',
]);
add(1288, [
  '不支持的需求只给区间，调用方可以按需展开 source。',
]);
add(1291, [
  'PEP 508 错误只给起点，完整信息在 source 里。',
]);
add(1302, [
  '远程读取错误展示 URL，不展示底层 reqwest 细节。',
  '这样即使用户没有开启 debug 日志也能看懂。',
]);
add(1349, [
  '文件级 file URL 错误与普通 URL 错误消息相同，只是多了文件名。',
]);
add(1361, [
  'URL 转路径失败在文件级错误里补上文件名，位置信息保持不变。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6c-6.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
