// 生成 VK-B1 基线快照：_files.txt（相对路径\t行数）、_meta.txt、orig/ 原样副本。
// 用法：node d:\code\_annot_baseline\vk-baseline.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = 'd:\\code\\opensource\\valkey';
const BASE = 'd:\\code\\_annot_baseline\\VK-B1';

const FILES = [
  'src/sds.h',
  'src/sds.c',
  'src/sdsalloc.h',
  'src/adlist.h',
  'src/adlist.c',
  'src/dict.h',
  'src/hashtable.h',
  'src/hashtable.c',
  'src/zmalloc.h',
  'src/zmalloc.c',
  'src/intset.h',
  'src/intset.c',
  'src/rax.h',
  'src/rax.c',
  'src/rax_malloc.h',
  'src/endianconv.h',
  'src/siphash.c',
  'src/crc16.c',
  'src/crc64.c',
  'src/crc64.h',
  'src/mutexqueue.h',
  'src/mutexqueue.c',
  'src/fifo.h',
  'src/fifo.c',
  'src/fmacros.h',
  'src/pqsort.c',
];

function countLines(text) {
  const parts = text.split('\n');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

function git(args) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  return (r.stdout || '').trim();
}

const status = git(['status', '--porcelain']);
if (status !== '') {
  console.error('worktree not clean:\n' + status);
  process.exit(2);
}

if (!fs.existsSync(BASE)) fs.mkdirSync(BASE, { recursive: true });
if (!fs.existsSync(path.join(BASE, 'orig'))) fs.mkdirSync(path.join(BASE, 'orig'), { recursive: true });

const rows = [];
for (const rel of FILES) {
  const src = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(src)) {
    console.error('missing: ' + rel);
    process.exit(2);
  }
  const text = fs.readFileSync(src, 'utf8');
  rows.push(rel + '\t' + countLines(text));
  const dst = path.join(BASE, 'orig', rel.split('/').join(path.sep));
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

fs.writeFileSync(path.join(BASE, '_files.txt'), rows.join('\n') + '\n');
fs.writeFileSync(
  path.join(BASE, '_meta.txt'),
  [
    'repo=https://github.com/valkey-io/valkey',
    'local=d:\\code\\opensource\\valkey',
    'branch=' + git(['rev-parse', '--abbrev-ref', 'HEAD']),
    'commit=' + git(['rev-parse', 'HEAD']),
    'collected=' + new Date().toISOString(),
    'scale=src/ 下 .c/.h 共 276 个文件 / 212719 行；本批 26 个文件',
    'parser=Android NDK 27.1.12297006 clang 18.0.2, --target=aarch64-linux-android21',
    'lines=按 \\n 切分，末尾换行不计为额外一行',
    'note=valkey 默认分支是 unstable，不是 main',
  ].join('\n') + '\n',
);
console.log('baseline written: ' + rows.length + ' files');
