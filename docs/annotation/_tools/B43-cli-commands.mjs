import fs from 'node:fs';

const REL = 'src/cli_commands.c';
const SRC = `d:/code/opensource/valkey/${REL}`;
const DIR = 'd:/code/_annot_baseline/VK-B43';

const E = [
  [1, [
    '/* cli_commands.c 只有一个职责：把 commands.def 的元数据翻译成 CLI 用的结构。 */',
    '/* 本文件不含运行逻辑，全部内容由下面的宏与 commands.def 展开而成。 */',
  ]],
  [4, '/* 下面几个宏是 commands.def 的“方言”，决定字段顺序与具体类型。 */'],
  [5, '/* MAKE_CMD 展开为 commandDocs 的初始化项：名称、摘要、组、起始版本、参数数。 */'],
  [9, '/* MAKE_ARG 展开为 cliCommandArg：类型、token、版本、flags、子参数数、弃用版本。 */'],
  [11, '/* COMMAND_ARG 指定参数结构体名，commands.def 里的 argv 用它声明数组。 */'],
  [12, '/* COMMAND_STRUCT 指定命令结构体名，顶层 commands 数组由它声明。 */'],
  [13, '/* 跳过历史表：CLI 不展示命令历史，省掉一份静态数据。 */'],
  [14, '/* 跳过 tips 表：提示文本只用于服务端 HELP 输出。 */'],
  [15, '/* 跳过 key specs 表：CLI 不做键位校验，避免把规格表链进来。 */'],
  [17, '/* 唯一数据来源：commands.def 按上面的宏展开成静态数组。 */'],
];

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const ops = [];
for (const [ln, c] of E) {
  const t = lines[ln - 1].trim();
  if (!t) { console.error('MISSING', ln); process.exit(2); }
  ops.push({ line: ln, expect: t, lines: Array.isArray(c) ? c : [c] });
}
ops.sort((a, b) => b.line - a.line);
fs.writeFileSync(`${DIR}/ins-c1.json`, JSON.stringify([{ file: REL, ops }], null, 1));
fs.writeFileSync(`${DIR}/out-cli_commands.json`, JSON.stringify(ops.map((o) => ({ line: o.line, c: o.lines })), null, 1));
console.log('ops', ops.length, 'lines', ops.reduce((s, o) => s + o.lines.length, 0));
