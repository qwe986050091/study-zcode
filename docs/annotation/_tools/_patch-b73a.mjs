import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/B73a-fuzzer.mjs';
let s = fs.readFileSync(p, 'utf8');
const rep = {
  134: '`fullname` 含子命令、以空格分隔，作为日志与注册表的展示名。',
  348: '短参数用 `%s ` 原样输出，尾随空格用于与下一个参数分隔。',
  423: '`enumConfigs` 以 NULL 结尾，循环即遍历全部白名单。',
  500: '用 `strcasecmp` 忽略大小写匹配 `key` 与白名单项。',
  611: '`val2` 独立取 rand()%1000，三个分值之间无约束。',
  621: '`%.1f` 保留一位小数，与服务端解析格式一致。',
  623: '`sdscat` 追加单个空格，作为百分位字段的分隔符。',
  626: '整个 `percentiles` 列表作为一个参数 append 到 cmd。',
  675: '转交后立即 return，避免落入 default 的字符串分支。',
  678: '同样在转交 `generateRandomSpecialValue` 后立即返回。',
  725: '按 `aclCategoriesCount` 逐项释放，与分配时的元素数一致。',
  728: '`zfree` 释放 `aclCategories` 指针数组本身。',
  730: '`aclCategoriesCount` 同步归零，使空数组的状态自洽。',
  738: '`initConfigDict` 先建空字典，解析过程中逐条填入。',
  747: '偶数位 `element[i]` 是配置名。',
  806: '`element[i + 1]` 是配对的值对象，类型按各键自行校验。',
  848: '`subcommands` 与顶层同构，也是键值对数组。',
  849: '`elements / 2` 得到子命令条数，追加到 `commandCount` 供一次性分配。',
  878: '`pipe == NULL` 时整串 `subcommandName` 就是子命令名。',
  897: '`strlcat` 先补一个空格，898 行再拼子命令。',
  914: '线性扫描 `commandRegistry` 找同名顶层命令。',
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
s = lines.join('\n');
fs.writeFileSync(p, s);
console.log('patched', hit, 'remaining', Object.keys(rep).join(','));
