import fs from 'node:fs';
const p = 'd:/code/_annot_baseline/B73c-fuzzer.mjs';
let s = fs.readFileSync(p, 'utf8');
const rep = {
  2263: '从 `subcmds` 随机取一个子命令名。',
  2297: '`return 0`，信息不全时按非阻塞超时处理。',
  2358: '`addArgumentToCommand` 递归生成选中的子参数。',
  2439: '`in_subscribe_mode` 置 0，下一轮回到普通命令采样。',
  2476: '`selectedCommand` 在普通路径与订阅路径都会赋值。',
  2479: '`rand() % commandRegistrySize` 在完整注册表里随机取一条。',
  2483: '`in_subscribe_mode` 为真时改走白名单选择，覆盖上面的随机结果。',
  2490: '生成后立即 `return`，不再追加参数或更新订阅态。',
  2502: '`strstr` 返回 NULL 时整串就是命令名。',
  2507: '`info.args` 非空才生成，模块命令可能没有参数。',
  2545: '`subCommand->argv[j]` 以带引号的字符串形式拼进脚本。',
  2577: '写回 `argv[idx2]`，完成一次交换。',
  2602: '`sdsnewlen` 按长度分配，下面整块填充。',
  2609: '`sdsnew` 把 \\r\\n 放进参数内容，检验服务端的长度前缀解析。',
  2620: '`rand() % cmd->argc` 随机挑一个参数位，可能选中命令名。',
  2630: '`cmd->argc <= 1` 时无可删除，直接返回。',
  2637: '`argv[k] = argv[k + 1]` 整体左移一格，覆盖被删槽位。',
  2648: '`rand() % 3` 三类多余参数等概率分派。',
  2652: 'case 1 随机数字：覆盖数值解析器对多余数字的处理。',
  2682: '`rand() % 4` 四类损坏等概率分派。',
  2684: 'case 1 调用 `corruptArgument` 替换单个参数内容。',
  2686: 'case 3 调用 `addRandomArgument` 插入一个多余参数。',
  2696: '`commandRegistry` 非空才遍历释放。',
  2698: '`freeCommandEntry` 只放内部指针，条目本身随数组一次性分配。',
  2707: '`configDict` 非空才释放。',
  2713: '最后 `zfree(fuzz_ctx)` 释放全局上下文。',
  2725: '`in_subscribe_mode` 置 0，新连接默认不在订阅态。',
  2741: '`subscribe_type` 同步归零。',
  2755: '`zfree(client_ctx)` 释放上下文本身。',
  2774: '损坏命令已经生成完毕，直接 `return cmd`。',
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
