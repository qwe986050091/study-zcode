import fs from 'node:fs';
const files = ['d:/code/opensource/valkey/src/throttle.c', 'd:/code/_annot_baseline/B64-throttle.mjs'];
const map = [
  ['最后释放条目本身。', '最后 `zfree(m)` 释放条目本身。'],
  ['遍历全局链表，给本次没有选中的维度补扣令牌。', '遍历全局 `throttler_list`，给本次没有选中的维度补扣令牌。'],
  ['多维度限流时，出队后要给其它桶补扣。', '多维度限流（`match_count > 1`）时，出队后要给其它桶补扣。'],
  ['排队客户端数加一。', '`num_clients_throttled` 加一。'],
  ['保存判据回调，遍历时调用。', '保存 `criteria_proc`，遍历时调用。'],
  ['挂到全局链表尾部。', '挂到全局 `throttler_list` 尾部。'],
  ['队列为空可以立即释放。', '队列为空（`listLength == 0`）可以立即释放。'],
  ['归零后令牌桶不再补充令牌，队列会一直等到速率被调高。', '归零后 `tokenBucket` 不再补充令牌，队列会一直等到速率被调高。'],
  ['记录起点；重复调用不会重置。', '记录 guardrail 起点；重复调用不会重置。'],
  ['速率回到阈值以上，清时间戳退出观察。', '速率回到阈值以上，清 `rate_below_guardrail_since` 退出观察。'],
  ['比例步进 + 最小步长。', '比例步进 + 最小步长 1 ops/s。'],
  ['摘队列并清三个字段。', '摘队列并清 `throttler`/`throttle_node`/`throttle_start` 三个字段。'],
  ['置位后本命令不再重复判定，重投递也不会再被拦。', '置 `throttle_checked` 后本命令不再重复判定，重投递也不会再被拦。'],
  ['遍历全局链表找最严格的实例。', '遍历全局 `throttler_list` 找最严格的实例。'],
  ['判据命中才计数并参与最严格比较。', '`criteria_proc` 命中才计数并参与最严格比较。'],
  ['速率更低者更严格；相等时保留先遇到的。', '速率更低者更严格；相等时保留先遇到的 `strictest`。'],
  ['无令牌：入队并摘读事件，等定时器重投递。', '无令牌：`throttlerAddClient` 入队并摘读事件，等定时器重投递。'],
  ['排队数直接读共享计数。', '`num_clients_throttled` 直接读共享计数。'],
  ['累计限流数同理。', '`num_commands_throttled` 同理。'],
  ['有排队才算延迟，空队列没有「最老客户端」。', '有排队（`listLength > 0`）才算延迟，空队列没有「最老客户端」。'],
  ['取各实例的最大值，报最坏情况。', '取各实例的最大值，报最坏情况。'],
];
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  for (const [a, b] of map) s = s.split(a).join(b);
  fs.writeFileSync(f, s);
}
console.log('done', files.length, map.length);
