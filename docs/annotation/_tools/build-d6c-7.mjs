import fs from 'node:fs';

const file = 'crates/uv-requirements-txt/src/lib.rs';
const S = 486;
const items = [];
const add = (old, lines) => items.push({ line: old + S, lines });

add(1454, [
  'io 错误是唯一不需要附加信息的变体，展示时直接透传。',
  '上游通常已经带上路径与 errno。',
  '因此这里不做二次包装，保持错误链最短。',
]);
add(1461, [
  'reqwest::Error 先转成 middleware 错误，保证变体类型统一。',
  '这样调用方只需要处理一种 Reqwest 变体。',
]);
add(1466, [
  'middleware 错误已经是目标类型，直接构造，不做额外分配。',
]);
add(1500, [
  '行列都从 1 开始，与编辑器和编译器的习惯一致。',
  '位置参数是字节偏移，可能落在字符中间，因此扫描时按字符前进。',
]);
add(1504, [
  '逐字符扫描到目标位置；遇到换行就重置列号。',
  '多字节字符按一个列计，不做视觉宽度换算。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6c-7.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
