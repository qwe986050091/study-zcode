import fs from 'node:fs';
const root = 'd:/code/opensource/valkey/';
const items = [
  ['src/bitops.c',1856],
  ['src/cluster_legacy.c',5579],
  ['src/cluster_legacy.c',6245],
  ['src/cluster_legacy.c',9678],
  ['src/cluster_legacy.c',9777],
  ['src/eval.c',1228],
  ['src/hashtable.c',2505],
  ['src/module.c',6223],
  ['src/module.c',7385],
  ['src/module.c',7660],
  ['src/module.c',12170],
  ['src/module.c',12549],
  ['src/module.c',12833],
  ['src/module.c',14536],
  ['src/module.c',17830],
  ['src/module.c',19649],
  ['src/modules/lua/script_lua.c',2806],
  ['src/object.c',2510],
  ['src/sentinel.c',3937],
  ['src/server.c',8933],
  ['src/t_hash.c',3740],
  ['src/t_hash.c',4040],
  ['src/t_hash.c',4413],
  ['src/t_set.c',1032],
  ['src/t_set.c',1871],
  ['src/t_stream.c',5525],
  ['src/t_stream.c',6291],
  ['src/t_string.c',1874],
  ['src/t_zset.c',1802],
  ['src/t_zset.c',2023],
  ['src/t_zset.c',3513],
  ['src/t_zset.c',4126],
  ['src/t_zset.c',4363],
  ['src/t_zset.c',4771],
  ['src/vset.c',1222],
  ['src/vset.c',2565],
];
for (const [f, ln] of items) {
  const lines = fs.readFileSync(root + f, 'utf8').split(/\r?\n/);
  console.log('\n=== ' + f + ':' + ln + ' ===');
  for (let i = Math.max(1, ln - 3); i <= Math.min(lines.length, ln + 4); i++) {
    console.log(String(i).padStart(6) + (i === ln ? ' *' : '  ') + lines[i - 1]);
  }
}
