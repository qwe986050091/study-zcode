import { execSync } from 'node:child_process';
const repo = 'd:/code/opensource/valkey';
const files = [
 'src/compression_lz4.c','src/compression_stream.c','src/config.c','src/debug.c','src/fbtree.c',
 'src/functions.c','src/fuzzer_client.c','src/fuzzer_command_generator.c','src/latency.c',
 'src/modules/lua/debug_lua.c','src/rax.c','src/stat_calc.c','src/throttle.c',
 'src/valkey-check-rdb.c','src/valkey-cli.c'];
for (const f of files) {
  const diff = execSync(`git -C ${repo} diff -U0 c96bdec..HEAD -- ${f}`, { encoding: 'utf8', maxBuffer: 1 << 28 });
  const lines = diff.split(/\r?\n/);
  // added line numbers in new file
  const added = [];
  let cur = 0;
  for (const L of lines) {
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(L);
    if (m) { cur = +m[1]; continue; }
    if (L.startsWith('+') && !L.startsWith('+++')) { added.push({ ln: cur, text: L.slice(1) }); cur++; }
    else if (L.startsWith('-') && !L.startsWith('---')) { /* no */ }
  }
  const src = execSync(`git -C ${repo} show HEAD:${f}`, { encoding: 'utf8', maxBuffer: 1 << 28 }).split(/\r?\n/);
  let inBody = 0, atTop = 0, other = 0;
  for (const a of added) {
    const t = a.text.trim();
    if (!(t.startsWith('/*') || t.startsWith('//'))) { other++; continue; }
    // find next non-blank, non-comment code line
    let j = a.ln; // src index = ln (next line)
    while (j < src.length) {
      const s = src[j].trim();
      if (s === '' || s.startsWith('/*') || s.startsWith('*') || s.startsWith('//')) { j++; continue; }
      break;
    }
    const next = j < src.length ? src[j] : '';
    const indent = next.length - next.trimStart().length;
    if (indent === 0) atTop++; else inBody++;
  }
  const totalSrc = src.length;
  console.log(`${f}\t+${added.length}\t注释顶格(签名/声明级) ${atTop}\t注释缩进(函数体内) ${inBody}\t非注释新增 ${other}\t行数 ${totalSrc}`);
}
