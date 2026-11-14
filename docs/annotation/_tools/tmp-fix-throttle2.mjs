import fs from 'node:fs';
const files = ['d:/code/opensource/valkey/src/throttle.c', 'd:/code/_annot_baseline/B64-throttle.mjs'];
const map = [
  ['从表头开始；遍历期间只扣令牌、不改链表，所以不需要安全迭代器。', '从表头开始；遍历期间只扣令牌、不改 `throttler_list`，所以不需要安全迭代器。'],
  ['读当前速率；后续三段分支都以它为基准。', '读 `tokenBucket_getRate` 的当前值；后续三段分支都以它为基准。'],
  ['迭代器在栈上；遍历期间不修改链表。', '迭代器在栈上；遍历期间不修改 `throttler_list`。'],
  ['命中数加一，出队时决定是否补扣其它桶。', '`match_count` 加一，出队时决定是否补扣其它桶。'],
  ['最老等待时长初始化，多个实例取最大。', '`oldest_client_delay_us` 初始化，多个实例取最大。'],
  ['速率求和：同名多实例的容量叠加。', '速率求和：同名多实例的 `ops_per_sec` 叠加。'],
  ['取各实例的最大值，报最坏情况。', '用 `MAX` 取各实例的最大值，报最坏情况。'],
  ['从头开始。', '从 `throttler_list` 表头开始。'],
  ['首次出现：记录时间戳。', '首次出现（`de != NULL`）：记录时间戳。'],
  ['初始化迭代器。', '`dictInitIterator` 初始化迭代器。'],
  ['循环变量。', '`de` 是循环变量。'],
];
for (const f of files) {
  let s = fs.readFileSync(f, 'utf8');
  for (const [a, b] of map) s = s.split(a).join(b);
  fs.writeFileSync(f, s);
}
console.log('done');
