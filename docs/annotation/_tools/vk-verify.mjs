// VK 批次注释校验器（C / valkey-io/valkey）
// 用法：node d:\code\_annot_baseline\vk-verify.mjs [批次名]   默认 VK-B1
//
// 口径：
//   1) 基线 orig/<rel> 与工作区 <rel> 用 git diff --no-index 比对；
//      deletedNonZero = 删除的「非空行」总数，>0 即失败（只允许新增注释/空行）。
//   2) 新增行必须是空行或注释（/*、*、// 开头）；
//      并做块注释状态机：新增的 /* 之后到新增的 */ 之前不得再出现 */，
//      防止注释体提前闭合；同一行内既开又闭的单行块注释一律不接受。
//   3) 语法校验：NDK clang -fsyntax-only
//      --target=aarch64-linux-android21 + sysroot + 声明 shim（见 _meta.txt）。
//      头文件（.h）走独立口径：-ffreestanding，并编译一个临时 TU
//      「#include "<prelude>" + #include "<目标头文件>"」，
//      因为头文件不是自包含的翻译单元（stream.h 需要 mstime_t、module.h 需要 list）。
//      prelude 由批次目录的 _prelude.txt 提供（rel<TAB>header[,header...]），
//      缺省为 server.h。目标头文件必须在 prelude 之后被真正解析一次，注释才被校验到。
//      退出码非 0 → syntaxErr 并整体失败。
//   4) fail-closed：clang 缺失、sysroot/shim 缺失、执行异常、超时(30s/文件)
//      一律计入 syntaxErr，绝不「跳过即通过」。
//   5) 平台白名单：批次目录下可选 _skip.txt（每行 rel<TAB>原因）。
//      命中者计入 skipped 并在 SUMMARY 可见，但仍执行 diff 口径检查。
//
// 输出末行固定格式：
//   SUMMARY files=<n> added=<n> deletedNonZero=<n> syntaxErr=<n> skipped=<n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = process.env.VK_ROOT || 'd:\\code\\opensource\\valkey';
const BASE_ROOT = process.env.VK_BASE || 'd:\\code\\_annot_baseline';
const batch = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'VK-B1';
const perFile = process.argv.includes('--per-file');
const BATCH_DIR = path.join(BASE_ROOT, batch);

const NDK = 'D:\\program\\android-env\\android-sdk\\ndk\\27.1.12297006\\toolchains\\llvm\\prebuilt\\windows-x86_64';
const CLANG = process.env.VK_CLANG || path.join(NDK, 'bin', 'clang.exe');
const SYSROOT = path.join(NDK, 'sysroot');
const SHIM = path.join(BATCH_DIR, 'annot-shim.h');

function die(msg) {
  console.error('FATAL: ' + msg);
  process.exit(2);
}

if (!fs.existsSync(BATCH_DIR)) die('baseline dir not found: ' + BATCH_DIR);
const manifest = path.join(BATCH_DIR, '_files.txt');
if (!fs.existsSync(manifest)) die('manifest not found: ' + manifest);

const rels = fs
  .readFileSync(manifest, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.split('\t')[0]);
if (!rels.length) die('empty manifest');

const skip = new Map();
const skipFile = path.join(BATCH_DIR, '_skip.txt');
if (fs.existsSync(skipFile)) {
  for (const line of fs.readFileSync(skipFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rel, reason] = line.split('\t');
    skip.set(rel.trim(), (reason || 'whitelisted-platform').trim());
  }
}

// ---------- 工具可用性（fail-closed） ----------
const clangOk = fs.existsSync(CLANG) && fs.existsSync(SYSROOT) && fs.existsSync(SHIM);
if (!clangOk) {
  console.error(
    `ERROR: syntax toolchain unavailable (clang=${fs.existsSync(CLANG)}, sysroot=${fs.existsSync(SYSROOT)}, shim=${fs.existsSync(SHIM)})`,
  );
}

const CFLAGS = [
  '-fsyntax-only',
  '--target=aarch64-linux-android21',
  '--sysroot=' + SYSROOT,
  '-Isrc',
  '-Ideps',
  '-Ideps/hdr_histogram',
  '-Ideps/fpconv',
  '-Ideps/fast_float',
  '-Ideps/lz4',
  '-Ideps/linenoise',
  '-Ideps/lua/src',
  '-Ideps/libvalkey/include',
  '-include',
  SHIM,
  '-DDEFAULT_CONFIG_FILE="valkey.conf"',
];

function firstError(stderr) {
  const line = (stderr || '')
    .split(/\r?\n/)
    .find((l) => /error:/.test(l));
  return (line || (stderr || '').trim().split(/\r?\n/)[0] || '').trim();
}

// ---------- 头文件支撑 ----------
// rel -> 需要先引入的头文件列表。缺省 server.h：它定义 mstime_t / robj / list 等
// 内部基础类型，是 src/*.h 事实上的公共前置。
const PRELUDE_FILE = path.join(BATCH_DIR, '_prelude.txt');
const preludes = new Map();
if (fs.existsSync(PRELUDE_FILE)) {
  for (const line of fs.readFileSync(PRELUDE_FILE, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rel, inc] = line.split('\t');
    preludes.set(
      rel.trim(),
      (inc || 'server.h')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
}

// 头文件模式额外要求的开关：-ffreestanding 去掉宿主 libc 假设；
// -I. 让临时 TU 里的 #include "src/xxx.h" 能从仓库根解析。
const HEADER_EXTRA = ['-I.', '-ffreestanding'];

const TU_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-hdr-'));
function makeHeaderTU(rel) {
  const includes = preludes.get(rel) || ['server.h'];
  const body = [...includes, rel].map((h) => `#include "${h}"`).join('\n') + '\n';
  const name = crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12) + '.c';
  const file = path.join(TU_DIR, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function isHeader(rel) {
  return rel.toLowerCase().endsWith('.h');
}

const syntaxCache = new Map();
function syntaxCheck(rel) {
  if (syntaxCache.has(rel)) return syntaxCache.get(rel);
  let res;
  if (!clangOk) {
    res = { status: 'err', msg: 'toolchain unavailable (fail-closed)' };
  } else {
    // 头文件编译的是「prelude + 目标头文件」的临时 TU，其余文件直接编译自身。
    const input = isHeader(rel) ? makeHeaderTU(rel) : rel;
    const flags = isHeader(rel) ? [...HEADER_EXTRA, ...CFLAGS] : CFLAGS;
    const r = spawnSync(CLANG, [...flags, input], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error) res = { status: 'err', msg: String(r.error) };
    else if (r.status !== 0) res = { status: 'err', msg: firstError(r.stderr) || 'exit ' + r.status };
    else res = { status: 'ok' };
  }
  syntaxCache.set(rel, res);
  return res;
}

// ---------- diff ----------
function git(args) {
  return spawnSync('git', ['--no-pager', ...args], {
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function numstat(a, b) {
  const r = git(['diff', '--no-index', '--numstat', '--', a, b]);
  let added = 0;
  let deleted = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    added += m[1] === '-' ? 0 : Number(m[1]);
    deleted += m[2] === '-' ? 0 : Number(m[2]);
  }
  return { added, deleted };
}

function diffLines(a, b) {
  const r = git(['diff', '--no-index', '-U0', '--', a, b]);
  const added = [];
  const deleted = [];
  let newLine = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      newLine = Number(h[1]);
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      added.push({ text: line.slice(1), line: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      deleted.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      newLine++;
    }
  }
  return { added, deleted };
}

// 新增行合法性：空行、或注释行；块注释不得提前闭合。
function checkAdded(rel, added, problems) {
  let open = false; // 是否处于「本次新增」打开的块注释内
  for (const a of added) {
    const raw = a.text;
    const t = raw.trim();
    const where = `${rel}:${a.line}`;
    if (t === '') {
      continue;
    }
    const startsBlock = t.startsWith('/*');
    const startsLine = t.startsWith('//');
    const startsStar = t.startsWith('*');
    if (!startsBlock && !startsLine && !startsStar) {
      problems.push(`NONCOMMENT ${where} ${t.slice(0, 80)}`);
      open = false;
      continue;
    }
    const closers = raw.split('*/').length - 1;
    if (!open) {
      if (closers > 0) {
        // 允许自包含的单行块注释「/* ... */」；但必须整行闭合且只有一次 */
        const selfContained = startsBlock && closers === 1 && t.endsWith('*/');
        if (!selfContained) {
          problems.push(`CLOSER ${where} 新增行在未开启块注释时出现 */`);
        }
        open = false;
        continue;
      }
      if (startsBlock) {
        open = true;
      }
      continue;
    }
    // 已在块注释内
    if (startsBlock) problems.push(`NESTED ${where} 块注释内又出现 /*`);
    if (closers === 0) continue;
    const onlyClose = t === '*/' || (t.endsWith('*/') && closers === 1);
    if (!onlyClose) {
      problems.push(`EARLY_CLOSE ${where} 注释体内出现 */`);
      open = false;
      continue;
    }
    const after = t.slice(t.lastIndexOf('*/') + 2).trim();
    if (after !== '') problems.push(`TRAILING ${where} */ 之后还有内容`);
    open = false;
  }
  if (open) problems.push(`UNCLOSED ${rel} 新增块注释未闭合`);
}

let files = 0;
let addedSum = 0;
let deletedNonZero = 0;
let syntaxErr = 0;
let skipped = 0;
const problems = [];

for (const rel of rels) {
  const baseFile = path.join(BATCH_DIR, 'orig', rel.split('/').join(path.sep));
  const curFile = path.join(ROOT, rel.split('/').join(path.sep));
  if (!fs.existsSync(baseFile) || !fs.existsSync(curFile)) {
    problems.push(`MISSING ${rel} (baseline=${fs.existsSync(baseFile)}, current=${fs.existsSync(curFile)})`);
    syntaxErr++;
    continue;
  }
  files++;
  const fileAdded = numstat(baseFile, curFile).added;
  addedSum += fileAdded;
  if (perFile) console.log(`FILE ${rel} +${fileAdded}`);

  const dl = diffLines(baseFile, curFile);
  const dz = dl.deleted.filter((s) => s.trim() !== '').length;
  deletedNonZero += dz;
  if (dz > 0) problems.push(`DELETED ${rel} 删除非空行 ${dz}`);
  checkAdded(rel, dl.added, problems);

  const whitelist = skip.get(rel);
  const sc = syntaxCheck(rel);
  if (whitelist) {
    skipped++;
    problems.push(`SKIPPED ${rel} (${whitelist})`);
  } else if (sc.status === 'err') {
    syntaxErr++;
    problems.push(`SYNTAX ${rel}: ${sc.msg}`);
  }
}

for (const p of problems) console.log(p);
console.log(
  `SUMMARY files=${files} added=${addedSum} deletedNonZero=${deletedNonZero} syntaxErr=${syntaxErr} skipped=${skipped}`,
);
const ok = files === rels.length && deletedNonZero === 0 && syntaxErr === 0 && skipped === 0 && problems.length === 0;
process.exit(ok ? 0 : 1);
