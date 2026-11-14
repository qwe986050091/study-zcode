import fs from 'node:fs';

const REL = 'src/modules/lua/list.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B51';

const E = [
  [13, '/* `val` 存调用方的 `void *`：链表不解释类型、不复制内容、更不负责释放，所有权始终在注册方。 */'],
  [14, '/* `next` 为 NULL 即链尾；`list_add` 的找尾循环与 `list_destroy` 的遍历都以它为唯一终止信号。 */'],
  [18, '/* `head` 为 NULL 表示空表；空表时 `list_add` 走直接挂头的分支，跳过找尾。 */'],
  [19, '/* `length` 是独立计数器而非遍历结果，`list_add` 自增、`list_destroy` 不读它，二者必须同步维护。 */'],
  [23, '/* `current` 指向下一个待返回节点；为 NULL 时 `list_iter_next` 返回结束信号。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const t = lines[ln - 1].trim();
  if (!t) { console.error('MISSING', ln); process.exit(2); }
  if (t.startsWith('/*') || t.startsWith('* ') || t === '*' || t.startsWith('//') || t.startsWith('#')) { console.error('BADANCHOR', ln, t); process.exit(2); }
  ops.push({ line: ln, expect: t, lines: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-v2.json`, JSON.stringify([{ file: REL, ops }], null, 1));

const prev = JSON.parse(fs.readFileSync(`${DIR}/out-list.json`, 'utf8'));
const all = prev.concat(ops.map((o) => ({ line: o.line, c: o.lines })));
fs.writeFileSync(`${DIR}/out-list.json`, JSON.stringify(all, null, 1));
console.log('ops', ops.length, 'total entries', all.length);
