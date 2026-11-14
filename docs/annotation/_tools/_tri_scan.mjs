// _tri_scan.mjs —— 三元臂行全量扫描（口径 = README §8.19「臂行」）
// 口径：整份源码先做代码掩码（注释/字符串/字符常量替换为等长空格，保留换行），
//       凡掩码后行首（忽略缩进）为 `?` 或 `:` 的行，记为一个「三元臂行」——
//         cond
//             ? a          ← 这一行
//             : b          ← 这一行
//       单行三元（`cond ? a : b`）不产生臂行，即 §8.19 所说的豁免；
//       臂行上方 0–2 个空行内、中间无代码行的注释，记为已写。
// 用途：`--table` 输出按文件分组的待补清单，并按 §8.20 的排期标注归属批次。
// 用法：node _tri_scan.mjs [repo] [--json out.json] [--unwritten] [--table]
import fs from 'node:fs';
import { execSync } from 'node:child_process';

const repo = process.argv[2] || 'd:/code/opensource/valkey';
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const outJson = arg('--json');

const files = execSync('git ls-files "src"', { cwd: repo, maxBuffer: 1 << 28 })
  .toString().split('\n').filter((f) => f.endsWith('.c'));

// 剩余池：与 README §3 表一致；用于把臂行映到批次
const STAGE = {
  'src/valkey-cli.c': 'S2', 'src/config.c': 'S3', 'src/debug.c': 'S4',
  'src/fbtree.c': 'S5', 'src/fuzzer_command_generator.c': 'S6',
  'src/rax.c': 'S1', 'src/functions.c': 'S1', 'src/valkey-check-rdb.c': 'S1',
  'src/modules/helloworld.c': 'S1', 'src/cli_common.c': 'S1', 'src/syscheck.c': 'S1',
  'src/crcspeed.c': 'S1', 'src/geohash_helper.c': 'S1', 'src/space_saving.c': 'S1',
  'src/modules/hellotype.c': 'S1', 'src/setproctitle.c': 'S1', 'src/crccombine.c': 'S1',
  'src/monotonic.c': 'S1', 'src/sha1.c': 'S1', 'src/commandlog.c': 'S1',
  'src/logreqres.c': 'S1', 'src/throttle_repl.c': 'S1', 'src/modules/helloblock.c': 'S1',
  'src/modules/helloacl.c': 'S1', 'src/notify.c': 'S1', 'src/sparkline.c': 'S1',
};

function mask(src) {
  let out = '';
  let i = 0;
  let st = 0; // 0 code, 1 sq, 2 dq, 3 line, 4 block
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (st === 0) {
      if (c === '/' && n === '/') { st = 3; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { st = 4; out += '  '; i += 2; continue; }
      if (c === '"') { st = 2; out += ' '; i++; continue; }
      if (c === "'") { st = 1; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (c === '\n') { if (st === 3) st = 0; out += '\n'; i++; continue; }
    if (st === 1) { if (c === '\\') { out += src[i + 1] === '\n' ? ' \n' : '  '; i += 2; continue; } if (c === "'") st = 0; out += ' '; i++; continue; }
    if (st === 2) { if (c === '\\') { out += src[i + 1] === '\n' ? ' \n' : '  '; i += 2; continue; } if (c === '"') st = 0; out += ' '; i++; continue; }
    if (st === 3) { out += ' '; i++; continue; }
    if (st === 4) { if (c === '*' && n === '/') { st = 0; out += '  '; i += 2; continue; } out += ' '; i++; continue; }
  }
  return out;
}

function hasCommentAbove(raw, idx) {
  for (let j = idx - 1, gap = 0; j >= 0 && gap <= 2; j--) {
    const t = raw[j].trim();
    if (t === '') { gap++; continue; }
    return t.startsWith('//') || t.startsWith('/*') || t.endsWith('*/') || t.startsWith('*');
  }
  return false;
}

const rows = [];
for (const rel of files) {
  const text = fs.readFileSync(`${repo}/${rel}`, 'utf8').replace(/\r\n/g, '\n');
  const raw = text.split('\n');
  const code = mask(text).split('\n');
  for (let i = 0; i < code.length; i++) {
    if (!/^\s*[?:](\s|\(|$)/.test(code[i])) continue;
    // 排除 `case`/标签残留与位域：掩码后行首是 ?/: 才可能是三元臂
    rows.push({
      rel, line: i + 1,
      text: raw[i].trim(),
      state: hasCommentAbove(raw, i) ? 'written' : 'empty',
      stage: STAGE[rel] || 'S7',
    });
  }
}

const stat = { total: rows.length, written: rows.filter((r) => r.state === 'written').length, empty: rows.filter((r) => r.state === 'empty').length };
console.log(JSON.stringify(stat));
if (process.argv.includes('--unwritten')) {
  for (const r of rows.filter((x) => x.state === 'empty')) console.log(`${r.rel}:${r.line}\t${r.stage}\t${r.text}`);
}
if (process.argv.includes('--table')) {
  const by = new Map();
  for (const r of rows.filter((x) => x.state === 'empty')) {
    if (!by.has(r.rel)) by.set(r.rel, []);
    by.get(r.rel).push(r);
  }
  for (const [rel, list] of [...by.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    console.log(`| ${rel} | ${list.map((r) => r.line).join(' / ')} | ${list.length} | ${list[0].stage} |`);
  }
}
if (outJson) fs.writeFileSync(outJson, JSON.stringify(rows, null, 1));
