import fs from 'node:fs';

const REL = 'src/modules/hellotimer.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B44';

const E = [
  [40, '/* 定时器回调：data 是 TimerCommand_ValkeyCommand 用 ValkeyModule_Alloc(256) 分配的串，所有权随 data 传入，必须由这里释放。 */'],
  [41, '/* ctx 在回调中不使用；VALKEYMODULE_NOT_USED 展开为 (void)ctx，消掉 -Wunused-parameter。 */'],
  [42, '/* 打印 "Fired After <delay>"；printf 仅作示例，真实模块应改用 ValkeyModule_Log 以免污染服务端标准输出。 */'],
  [43, '/* ValkeyModule_Free 与 Alloc 成对：不释放则每次触发泄漏 256 字节，10 个定时器各泄一次。 */'],
  [47, '/* HELLOTIMER.TIMER 命令入口：一次性注册 10 个 0–4999ms 随机延迟定时器，然后立即回 OK。 */'],
  [48, '/* argv 未使用：命令不接受参数。 */'],
  [49, '/* argc 同样未使用；命令不校验参数个数，多传参数也不会报错。 */'],
  [51, '/* 固定 10 次：演示批量注册；次数与 argv 无关，改大只会增加定时器数量。 */'],
  [52, '/* rand()%5000 落在 0–4999ms，低值区间更密，仅用于演示而非均匀分布。 */'],
  [53, '/* 每个定时器单独分配 256 字节；分配失败时 ValkeyModule_Alloc 直接 abort，不会返回 NULL。 */'],
  [54, '/* snprintf 以 256 为上限，delay 最多 4 位十进制，实际不会截断。 */'],
  [55, '/* CreateTimer 返回后即开始计时，到点由模块线程池调用 timerHandler，buf 作为 data 传出。 */'],
  [56, '/* tid 是取消句柄；示例不调用 StopTimer，显式作废以免 -Wunused-variable。 */'],
  [58, '/* 回复 "+OK" 时定时器已在队列中，客户端收到回复后才陆续触发。 */'],
  [63, '/* 模块入口：Init 或命令注册任一失败都返回 VALKEYMODULE_ERR，加载中止且不注册任何命令。 */'],
  [64, '/* OnLoad 的 argv 未使用：示例模块不从配置文件读参数。 */'],
  [65, '/* argc 同 argv 未使用；参数校验留空，加载时的多余参数被忽略。 */'],
  [67, '/* 声明模块名 "hellotimer" 与 API 版本 1；返回 ERR 时后续 API 都不能再调用。 */'],
  [69, '/* 注册 hellotimer.timer，flags=readonly；arity 与三个 key 参数均为 0，表示不限制参数数、无键。 */'],
  [71, '/* 注册失败直接返回 ERR，模块不会被加载，也不会留下半注册状态。 */'],
  [73, '/* 两步都成功才返回 OK，模块加载完成。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const t = lines[ln - 1].trim();
  if (!t) { console.error('MISSING', ln); process.exit(2); }
  if (t.startsWith('/*') || t.startsWith('*') || t.startsWith('#')) { console.error('BADANCHOR', ln, t); process.exit(2); }
  ops.push({ line: ln, expect: t, lines: Array.isArray(c) ? c : [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-h1.json`, JSON.stringify([{ file: REL, ops }], null, 1));
fs.writeFileSync(`${DIR}/out-hellotimer.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length, 'lines', ops.reduce((s, o) => s + o.lines.length, 0));
