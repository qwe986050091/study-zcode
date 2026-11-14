import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/B73b-fuzzer.mjs';
let s = fs.readFileSync(p, 'utf8');
const rep = {
  1289: '`element[j + 1]` 是配对的参数数组。',
  1292: '`argCount` 与数组同时落定，释放时按它遍历。',
  1300: '`element[j + 1]` 是子命令表，结构与顶层命令表同构。',
  1315: '返回 `next` 指向的下一个空槽；顶层调用者拿到的就是最终填充长度。',
  1349: '在刚建好的 `commandRegistry` 里找 `allowedCommands` 中的命令。',
  1376: '`subargs` 置空后本函数可安全重复调用。',
  1398: '`zfree` 释放 `argv` 指针数组本身。',
  1482: '`commandRegistrySize--` 后，下一次循环仍停在同一下标检查覆盖进来的末元素。',
  1484: '保留的条目执行 `i++`；删除时下标不动，直接检查覆盖进来的末元素。',
  1495: '`struct timeval tv` 取微秒级时间，作为种子的一部分。',
  1517: '`aclCategoriesCount` 与指针同步初始化，空数组状态自洽。',
  1573: '`commandDocs` 判空后释放，未收到的回复不会重复释放。',
  1690: '信息不全时 `return 0`，走普通字符串生成。',
  1768: '`rand() % aclCategoriesCount` 的下标必然落在已解析区间。',
  1774: '`fallback_cats` 同样拼 +@ 前缀，只是分类来源不同。',
  1785: '`fallback_cats` 走同一格式，仅分类来源不同。',
};
const lines = s.split('\n');
let hit = 0;
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^  \[(\d+), '.*'\],$/);
  if (!m) continue;
  const n = Number(m[1]);
  if (!(n in rep)) continue;
  lines[i] = `  [${n}, '${rep[n]}'],`;
  hit++;
  delete rep[n];
}
fs.writeFileSync(p, lines.join('\n'));
console.log('patched', hit, 'remaining', Object.keys(rep).join(','));
