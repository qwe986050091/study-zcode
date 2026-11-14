import fs from 'node:fs';

const REL = 'src/throttle_token_bucket.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B53';

const E = [
  [12, '/* 补充速率：每微秒累加 `tokens_per_sec / 1e6` 个令牌，改它必须同时重算容量。 */'],
  [13, '/* 突发窗口：容量 = 2 + 速率 * 该值，值越大允许的瞬时突发越长。 */'],
  [14, '/* 令牌数可为负，只有 `force_consume` 能透支；下限由 `trimTokenBucket` 钳在负容量。 */'],
  [15, '/* 单调时钟微秒值，只在补充完成后前移，保证同一段时间不会被重复计入。 */'],

  [25, '/* 速率低于 `BUCKET_EPSILON`（0.0001）视为关闭：容量取 0，避免极低速率下 `rate*burst` 产生的碎令牌被当成可用。 */'],
  [26, '/* 容量下限 2 个令牌：即使 `tokens_per_sec * max_burst_time_secs < 1` 也至少能攒到 1，不会永久饿死。 */'],

  [31, '/* 每次都按当前速率重算容量，不缓存：`setRate` 改速率后容量立即跟着变。 */'],
  [32, '/* 上限钳制：补充只受容量约束，超出部分直接丢弃而不是留到下次。 */'],
  [33, '/* 下限钳制：透支深度也被限制在 -容量，`msUntilAvailable` 的等待时间因此有界。 */'],

  [40, '/* 取单调时钟：墙体时间被回拨也不会倒退，避免 `delta_us` 回绕。 */'],
  [41, '/* 无符号减法在时钟倒退时会得到天文数字，这里依赖 `getMonotonicUs` 的不回退前提。 */'],
  [42, '/* 微秒换算成秒：除以 `1000000.0` 而不是整数，保证结果是浮点、不先截断。 */'],
  [43, '/* 累加到现有令牌数；透支状态下这里是「还债」，可能仍为负。 */'],
  [44, '/* 补充后立刻钳制，防止长暂停后一次涌入超过容量。 */'],
  [45, '/* 时间戳最后才前移：若在累加前更新，中途失败或提前返回就会丢掉这段时间。 */'],

  [49, '/* 精确分配一个 `tokenBucket`，内容未初始化，四个字段随后逐个赋值。 */'],
  [50, '/* 先写速率：下一行的 `getBucketSize` 会读它，顺序反了容量就按旧值算。 */'],
  [51, '/* 突发窗口必须在算容量前写好，同样是因为 `getBucketSize` 依赖它。 */'],
  [52, '/* 初始装满到容量，使第一次 `tryConsume` 不必等待；低速率下这里可能得到 0。 */'],
  [53, '/* 以创建时刻为补充基准，首次 `replenish` 的 `delta_us` 近似为 0。 */'],
  [54, '/* 返回堆上对象，所有权交给调用方，配套 `tokenBucket_free`。 */'],

  [58, '/* 与 `zmalloc` 配对；对象内部没有二级分配，一次 `zfree` 即可。 */'],

  [62, '/* 只读配置速率，不触发补充：返回值不代表当前可用令牌数。 */'],

  [66, '/* 先用旧速率结清已过去的时间，否则切换瞬间的这段会被按新速率计价。 */'],
  [67, '/* 写入新速率后，容量计算随之改变。 */'],
  [68, '/* 按新容量重新钳制：升速可放大突发额度，降速则把透支深度一并收紧。 */'],

  [72, '/* 先把令牌补到当前时刻，再做可用性判断；跳过这步会用到过期计数。 */'],
  [73, '/* 非强制模式下令牌不足立即失败、不扣减；`force_consume` 为真时跳过该判断。 */'],
  [74, '/* 扣减允许为负：强制消费本质是记账式透支。 */'],
  [75, '/* 扣减后再钳制，把债务限制在 -容量，保证后续等待时间可计算且有界。 */'],
  [76, '/* 返回成功；透支情况下调用方拿到的是「先欠后还」的许可。 */'],

  [80, '/* 同样先补充，保证基于最新计数估算等待时间。 */'],
  [81, '/* 余额已够则无需等待，返回 0 而不是负数。 */'],
  [83, '/* 零速率是「永久不可用」而非「立即可用」，用 -1 与 0 区分这两种语义。 */'],
  [84, '/* 缺口按目标值减当前值计算；当前值为负时缺口会大于 `target_tokens`。 */'],
  [85, '/* 秒转毫秒：除以速率得到秒，再乘 1000；整数常量写成浮点避免截断。 */'],
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
fs.writeFileSync(`${DIR}/ins-v1.json`, JSON.stringify([{ file: REL, ops }], null, 1));
fs.writeFileSync(`${DIR}/out-throttle_token_bucket.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length, 'lines', ops.reduce((s, o) => s + o.lines.length, 0));
