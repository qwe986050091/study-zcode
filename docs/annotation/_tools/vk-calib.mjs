// 校准取样：对指定文件抽 W 命中，附 2 行后续代码，输出 TSV 供人工三分类。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { judgeEntries, isSep } from './zc-gate.mjs';

const ROOT = 'd:\\code\\opensource\\valkey';
const targets = {
  'src/crc16_slottable.c': 15,
  'src/defrag.c': 20,
  'src/kvstore.c': 15,
  'src/bgiteration.c': 20,
  'src/valkey-benchmark.c': 10,
  'src/fuzzer_client.c': 5,
  'src/modules/lua/debug_lua.c': 5,
  'src/pqsort.c': 5,
  'src/sds.c': 5,
};

const out = ['seq\tfile\tline\tcomment\tcode1\tcode2'];
let seq = 0;
for (const [rel, want] of Object.entries(targets)) {
  const r = spawnSync('git', ['--no-pager', 'diff', '-U0', 'HEAD', '--', rel], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const entries = [];
  let n = 0;
  let inBlock = false;
  for (const line of r.stdout.split(/\r?\n/)) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      n = Number(h[1]);
      inBlock = false;
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      const t = line.slice(1).trim();
      if (inBlock) {
        const c = t.replace(/^\*\s?/, '').replace(/\*\/$/, '').trim();
        if (c) entries.push({ line: n, content: c });
        if (t.includes('*/')) inBlock = false;
      } else if (t.startsWith('//')) {
        const c = t.replace(/^\/\/\s?/, '').trim();
        if (c && !isSep(c)) entries.push({ line: n, content: c });
      } else if (t.startsWith('/*')) {
        const c = t.replace(/^\/\*+\s?/, '').replace(/\*\/$/, '').trim();
        if (c) entries.push({ line: n, content: c });
        if (!t.includes('*/')) inBlock = true;
      }
      n++;
    } else if (line.startsWith(' ')) n++;
  }
  const w = judgeEntries(entries).filter((x) => x.kind === 'W');
  if (!w.length) continue;
  const src = fs.readFileSync(ROOT + '\\' + rel.split('/').join('\\'), 'utf8').split(/\r?\n/);
  const step = Math.max(1, Math.floor(w.length / want));
  let taken = 0;
  for (let i = 0; i < w.length && taken < want; i += step) {
    const f = w[i];
    const text = f.lines.join(' / ');
    let c1 = '';
    let c2 = '';
    for (let j = f.endLine; j < src.length && (!c1 || !c2); j++) {
      const t = src[j].trim();
      if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
      if (!c1) c1 = t;
      else c2 = t;
    }
    seq++;
    out.push([seq, rel, f.line, text, c1, c2].join('\t'));
    taken++;
  }
}
fs.writeFileSync('d:\\code\\_annot_baseline\\vk-calib.tsv', out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
