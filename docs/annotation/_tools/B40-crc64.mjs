// B40：crc64.c 单文件单片（查表与常量 / 位反转 / 逐位参考实现 / 热路径入口）。
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const REPO = 'd:/code/opensource/valkey';
const REL = 'src/crc64.c';
const SRC = `${REPO}/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B40';
const PX = 'p0';

fs.mkdirSync(`${DIR}/orig/src`, { recursive: true });
fs.writeFileSync(`${DIR}/orig/${REL}`, execSync(`git show HEAD:${REL}`, { cwd: REPO, encoding: 'buffer' }));
fs.writeFileSync(`${DIR}/_files.txt`, `${REL}\n`);
if (!fs.existsSync(`${DIR}/annot-shim.h`)) fs.copyFileSync('d:/code/_annot_baseline/VK-B39/annot-shim.h', `${DIR}/annot-shim.h`);
if (!fs.existsSync(`${DIR}/out-crc64.json`)) fs.writeFileSync(`${DIR}/out-crc64.json`, '[]');

const E = [
  [43, '/* 8×256 查表零初始化；crc64_init 未调用时整表全 0。 */'],
  [45, '/* POLY 是 ECMA-182 反射多项式，改它会让历史 RDB/AOF 校验和失效。 */'],
  [101, '/* GCC/clang 有 bswap64 时走一条指令，否则退回下面的掩码实现。 */'],
  [102, '/* __builtin_bswap64 做字节反转，省掉 8 步掩码交换。 */'],
  [103, '/* 非 GCC/clang 分支，结果必须与 bswap64 完全一致。 */'],
  [110, '/* 条件编译收口：两条路径得到同一个 reflected 值。 */'],
  [129, '/* data 只是去掉 const void 的别名，不复制缓冲区。 */'],
  [130, '/* bit 暂存“本位是否触发异或”的判断结果。 */'],
  [132, '/* 逐字节推进；每字节处理 8 位后 crc 正好移完一个字节。 */'],
  [133, '/* c 是本轮字节，位序按 LSB→MSB 处理即 ReflectIn。 */'],
  [134, '/* i 从 0x01 左移到 0x80，循环恰好 8 次。 */'],
  [135, '/* 取 crc 最高位，移位后它会被挤出。 */'],
  [136, '/* 输入位为 1 时翻转 bit，等价于反射输入的异或。 */'],
  [137, '/* 翻转后 bit 为 1 才在下面异或 POLY。 */'],
  [140, '/* 左移一位，把刚处理的最高位挤出 64 位窗口。 */'],
  [141, '/* bit 为 1 则异或 POLY，即 CRC 的多项式除法。 */'],
  [142, '/* 异或反射多项式，消除被挤出的那一位。 */'],
  [146, '/* 每字节末尾截断到 64 位，保持中间值宽度。 */'],
  [149, '/* 最终再截断一次，防止移位残留高位。 */'],
  [150, '/* 反射输出；XorOut=0，所以异或项写成 0。 */'],
  [160, '/* 用参考实现 _crc64 填 8 张切片表，仅启动期执行一次。 */'],
  [168, '/* 热路径 slicing-by-8 一次吃 8 字节，crc 作为增量状态传入。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const cur = lines[ln - 1];
  if (cur === undefined) {
    console.error(`MISSING ${ln}`);
    process.exit(2);
  }
  const t = cur.trim();
  if (!t || t.startsWith('/*') || t.startsWith('//') || /^\*\s/.test(t)) {
    console.error(`BADANCHOR ${ln} ${t}`);
    process.exit(2);
  }
  ops.push({ line: ln, expect: t, lines: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-${PX}.json`, JSON.stringify([{ file: REL, ops }], null, 1));

const out = `${DIR}/out-crc64.json`;
const prev = JSON.parse(fs.readFileSync(out, 'utf8'));
const entries = ops.map((o) => ({ line: o.line, c: o.lines }));
fs.writeFileSync(out, JSON.stringify([...prev, ...entries], null, 1));
console.log(`${PX} ops=${ops.length} entries=${prev.length + entries.length}`);
