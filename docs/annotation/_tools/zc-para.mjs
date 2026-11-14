// 段落级复核（二遍判据）：zc-gate 的 W/L 按「行」判，会把折行续句与带枚举的长句误判为注水。
// poem run / B 堆叠仍按行判（它们本来就是「连续短行」的定义），只对 W/L 命中做块级复核：
// 把同一段连续 // 注释拼成一段再判 W/L，通过者记为 wlArtifact（误判），不通过者记为 wlGenuine。
// 用途：把行级水率（偏大）还原成真实待修量；真实队列只含 poem + wlGenuine。
// 用法：
//   node zc-para.mjs --file <rel> [--show]       单文件复核
//   node zc-para.mjs --queue <list.txt>          批量复核，写 zc-work-queue-true.txt
import fs from 'node:fs';
import { scanFile, contentOf, isWeakContent } from './zc-gate.mjs';

// PRED 在 gate 的谓词表外补入折行句里常见的后果词，避免「枚举 + 避免/不得」被当成无信息。
const PRED =
  /(若|则|会|导致|必须|不能|只能|返回|抛出|写入|读取|分配|释放|等于|大于|小于|防止|保证|确保|因为|所以|但是|而|由|让|保持|限制|覆盖|指向|持有|借用|观测|依赖|产生|触发|恢复|丢弃|重试|拒绝|跳过|合并|拆分|先|再|最后|不得|避免|不允许)/;

function blocksOf(text) {
  const blocks = [];
  let cur = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i].trim().startsWith('//')) {
      if (!cur) {
        cur = { start: i + 1, txt: [] };
        blocks.push(cur);
      }
      cur.txt.push(contentOf(text[i]));
    } else cur = null;
  }
  return blocks;
}

// 返回 { poem:Set, wl:Set, genuine:Set, artifact:Set }
export function review(rel) {
  const res = scanFile(rel);
  const poem = new Set();
  const wl = new Set();
  for (const f of res.findings) {
    const s = f.kind === 'POEM' || f.kind === 'B' ? poem : wl;
    for (let l = f.line; l <= f.endLine; l++) s.add(l);
  }
  const text = fs.readFileSync('D:/code/ZCode/' + rel, 'utf8').split(/\r?\n/);
  const blocks = blocksOf(text);
  const bo = new Map();
  for (const b of blocks) for (let k = 0; k < b.txt.length; k++) bo.set(b.start + k, b);
  const genuine = new Set();
  const artifact = new Set();
  for (const l of wl) {
    if (poem.has(l)) continue;
    const b = bo.get(l);
    if (!b) {
      genuine.add(l);
      continue;
    }
    const joined = b.txt.join('');
    const seps = (joined.match(/[、,，]/g) ?? []).length;
    const bad = isWeakContent(joined) || (seps >= 2 && !PRED.test(joined));
    (bad ? genuine : artifact).add(l);
  }
  return { rel, res, poem, wl, genuine, artifact };
}

const argv = process.argv.slice(2);
const i = argv.findIndex((a) => a === '--file' || a === '--queue');
if (i < 0) {
  console.error('usage: node zc-para.mjs --file <rel> [--show] | --queue <list.txt>');
  process.exit(2);
}
if (argv[i] === '--file') {
  const r = review(argv[i + 1]);
  console.log(
    `SUMMARY ${r.rel} added=${r.res.addedCommentLines} poem=${r.poem.size} wl=${r.wl.size} artifact=${r.artifact.size} genuine=${r.genuine.size}`,
  );
  if (argv.includes('--show'))
    for (const l of [...r.genuine].sort((a, b) => a - b)) console.log(`  ${l}`);
} else {
  const rels = fs
    .readFileSync(argv[i + 1], 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    // 兼容队列格式：`water\tadded\tbatch\tera\trel`，取最后一列；纯路径列表原样使用。
    .map((s) => s.split('\t').pop());
  let added = 0;
  let poem = 0;
  let genuine = 0;
  let artifact = 0;
  const rows = [];
  for (const rel of rels) {
    let r;
    try {
      r = review(rel);
    } catch {
      continue;
    }
    added += r.res.addedCommentLines;
    poem += r.poem.size;
    genuine += r.genuine.size;
    artifact += r.artifact.size;
    if (r.genuine.size > 0) rows.push({ rel, genuine: r.genuine.size, poem: r.poem.size });
  }
  rows.sort((a, b) => b.genuine - a.genuine || a.rel.localeCompare(b.rel));
  fs.writeFileSync(
    'D:/code/_annot_baseline/zc-work-queue-true.txt',
    rows.map((r) => `${r.genuine}\t${r.poem}\t${r.rel}`).join('\n') + '\n',
    'utf8',
  );
  console.log(
    `SUMMARY files=${rels.length} added=${added} poem=${poem} wlGenuine=${genuine} wlArtifact=${artifact} trueWater=${poem + genuine} trueRate=${(((poem + genuine) / added) * 100).toFixed(2)}%`,
  );
  for (const r of rows.slice(0, 10)) console.log(`${r.genuine}\t${r.poem}\t${r.rel}`);
}
