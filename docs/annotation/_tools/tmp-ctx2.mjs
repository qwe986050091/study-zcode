import fs from 'node:fs';
const list = [
  ['src/modules/lua/script_lua.c', 413, 18, 6], ['src/sentinel.c', 2341, 10, 8], ['src/t_stream.c', 1760, 10, 6],
  ['src/t_zset.c', 5086, 12, 6], ['src/t_zset.c', 5124, 12, 6], ['src/valkey-cli.c', 7047, 6, 26],
  ['src/t_set.c', 1170, 8, 4], ['src/t_zset.c', 726, 8, 4],
];
for (const [f, line, before, after] of list) {
  const src = fs.readFileSync(`d:/code/opensource/valkey/${f}`, 'utf8').split(/\r?\n/);
  console.log(`\n===== ${f}:${line}`);
  for (let i = Math.max(0, line - before); i < Math.min(src.length, line + after); i++) {
    console.log(`${i + 1}${i + 1 === line ? ' >>' : '   '} ${src[i]}`);
  }
}
