import fs from 'node:fs';

const REL = 'src/strl.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B46';

// 行号为当前（已插入 27 行后）文件的行号；out 里换回原始行号。
const E = [
  [24, '/* 返回完整源串长度而非实际拷贝字节数：调用方用 retval>=dsize 区分「拷完」与「被截断」。 */', 24],
  [68, '/* dsize 是 dst 的总容量而非剩余空间，与 strncat 语义相反，差值由函数自己算。 */', 56],
  [76, '/* dlen 在扫描结束后用 dst-odst 回填，此处仅声明，避免在循环前多算一次长度。 */', 61],
  [81, '/* 循环体只有指针前进：终止条件同时受剩余步数 n 和当前字节是否为 NUL 约束。 */', 65],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c, orig] of E) {
  const t = lines[ln - 1].trim();
  if (!t) { console.error('MISSING', ln); process.exit(2); }
  if (t.startsWith('/*') || t.startsWith('* ') || t === '*' || t.startsWith('//') || t.startsWith('#')) { console.error('BADANCHOR', ln, t); process.exit(2); }
  ops.push({ line: ln, expect: t, lines: [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-v2.json`, JSON.stringify([{ file: REL, ops }], null, 1));

const outp = `${DIR}/out-strl.json`;
const out = JSON.parse(fs.readFileSync(outp, 'utf8'));
for (const [ln, c, orig] of E) out.push({ line: orig, c: [c] });
out.sort((a, b) => a.line - b.line);
fs.writeFileSync(outp, JSON.stringify(out, null, 1));
console.log('ops', ops.length, 'entries', out.length);
