import fs from 'node:fs';
const list = [
  ['src/cluster_legacy.c', 6733], ['src/cluster_legacy.c', 8141], ['src/db.c', 1617], ['src/db.c', 3517],
  ['src/module.c', 5476], ['src/modules/lua/script_lua.c', 413], ['src/sentinel.c', 2246], ['src/server.c', 13160],
  ['src/t_list.c', 1307], ['src/t_stream.c', 4853], ['src/t_string.c', 2068], ['src/tls.c', 2103],
  ['src/tracking.c', 893], ['src/module.c', 10149], ['src/module.c', 11382], ['src/bgiteration.c', 3209],
];
for (const [f, line] of list) {
  const src = fs.readFileSync(`d:/code/opensource/valkey/${f}`, 'utf8').split(/\r?\n/);
  console.log(`\n===== ${f}:${line}`);
  for (let i = Math.max(0, line - 8); i < Math.min(src.length, line + 7); i++) {
    console.log(`${i + 1}${i + 1 === line ? ' >>' : '   '} ${src[i]}`);
  }
}
