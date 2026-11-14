import fs from 'node:fs';

const file = 'crates/uv-requirements-txt/src/lib.rs';
const S = 496;
const items = [];
const items2 = items;
const add = (old, lines) => items2.push({ line: old + S, lines });

add(1136, [
  'file 用 Box 包装，避免错误枚举因来源类型过大而膨胀。',
  '它决定展示时使用的文件名，也参与快照过滤。',
]);
add(1137, [
  'error 是具体的解析失败原因，source 链从这里展开。',
  '两者组合后既能定位文件，也能看到最底层的原因。',
]);

fs.writeFileSync('d:\\code\\_annot_baseline\\spec-d6c-8.json', JSON.stringify([{ file, items }], null, 2));
console.log('items', items.length, 'lines', items.reduce((n, i) => n + i.lines.length, 0));
