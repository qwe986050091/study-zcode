// 批次注释校验脚本（C / mit-pdos/xv6-riscv）
// 用法：node D:\code\_annot_baseline\XV-verify.mjs <批次名>
//   例：XV-verify.mjs xv6-riscv-b1 或 XV-verify.mjs XV-xv6-riscv-b1
// 口径：
//   1) 基线 vs 工作区逐文件 git diff --no-index --numstat：统计新增/删除
//   2) deletedNonZero = 删除的“非空行”总数（空行删除不计），>0 即失败
//   3) 新增行必须是注释或空行（C：//、/*、* 开头），且新增行内不得出现 */
//   4) 语法校验用 clang（本机 Android NDK 自带）：
//      - kernel/、user/ 下的 .c：-target riscv64-unknown-elf -fsyntax-only
//      - mkfs/ 下的 .c：主机工具，用 NDK sysroot（aarch64-linux-android）解析
//      - .h：找到仓库内 #include 它的 .c，编译该 .c（头文件只能在其上下文中合法）
//      - .S：用 clang -c 汇编到临时文件
//   5) fail-closed：clang/解析器缺失、执行异常、无法定位头文件包含者，都会计入 skipped 或
//      syntaxErr，并以非零码退出；绝不把“没检查”当成“通过”
// 工作目录：所有解析器都在系统临时目录下执行，避免被仓库工具链配置劫持
// 输出末行：SUMMARY files=<n> added=<n> deletedNonZero=<n> skipped=<n> syntaxErr=<n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PREFIX = 'XV';
const DEFAULT_ROOT = 'd:\\code\\opensource\\xv6-riscv';
const DEFAULT_BASE = 'd:\\code\\_annot_baseline';
const ROOT = process.env.ANNOT_ROOT || DEFAULT_ROOT;
const BASE = process.env.ANNOT_BASE || DEFAULT_BASE;

const rawArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!rawArg) {
  console.error('usage: node XV-verify.mjs <batch>');
  process.exit(2);
}
const batch = rawArg.startsWith(PREFIX + '-') ? rawArg : PREFIX + '-' + rawArg;
const batchDir = path.join(BASE, batch);
if (!fs.existsSync(batchDir)) {
  console.error('baseline not found: ' + batchDir);
  process.exit(2);
}

const manifest = path.join(batchDir, '_files.txt');
if (!fs.existsSync(manifest)) {
  console.error('manifest not found: ' + manifest);
  process.exit(2);
}
const rels = fs
  .readFileSync(manifest, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.split(/\s+/)[0]);

if (rels.length === 0) {
  console.error('empty manifest: ' + manifest);
  process.exit(2);
}

const NEUTRAL_CWD = os.tmpdir();

// ---------- clang 定位（fail-closed） ----------
function findClang() {
  const cands = [];
  if (process.env.CLANG) cands.push(process.env.CLANG);
  cands.push('clang');
  const ndkRoot = 'D:\\program\\android-env\\android-sdk\\ndk';
  try {
    for (const d of fs.readdirSync(ndkRoot).sort().reverse()) {
      cands.push(path.join(ndkRoot, d, 'toolchains', 'llvm', 'prebuilt', 'windows-x86_64', 'bin', 'clang.exe'));
    }
  } catch {
    /* NDK 不存在时忽略 */
  }
  for (const c of cands) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', cwd: NEUTRAL_CWD });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}
const clang = findClang();
const sysroot = clang
  ? path.join(path.dirname(path.dirname(clang)), 'sysroot')
  : null;
if (!clang) console.error('ERROR: clang not found, C syntax check will be skipped (fail-closed)');

function clangArgs(file, rel) {
  const inc = ['-I', ROOT, '-I', path.join(ROOT, 'kernel'), '-I', path.join(ROOT, 'user')];
  if (rel.replace(/\\/g, '/').startsWith('mkfs/')) {
    return [
      '-fsyntax-only', '-w', '-Wno-implicit-function-declaration', '-std=gnu11',
      '-target', 'aarch64-linux-android21', '--sysroot=' + sysroot,
      '-I', ROOT, file,
    ];
  }
  // -ffreestanding：xv6 是裸机内核，没有 libm/libc；不关掉内建函数声明时
  // kernel/log.c 的全局变量 log 会与内建函数 log() 冲突（redefinition as
  // different kind of symbol），这是编译器宿主语义误判，不是源码错误。
  return ['-fsyntax-only', '-w', '-std=gnu11', '-ffreestanding', '-target', 'riscv64-unknown-elf', ...inc, file];
}

// 头文件包含者索引：basename -> [.c 相对路径]
const includers = new Map();
function buildIncluderIndex() {
  const stack = [ROOT];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && /\.c$/i.test(e.name)) {
        let txt = '';
        try {
          txt = fs.readFileSync(p, 'utf8');
        } catch {
          continue;
        }
        const rel = path.relative(ROOT, p).replace(/\\/g, '/');
        for (const m of txt.matchAll(/#include\s+"([^"]+\.h)"/g)) {
          const b = path.basename(m[1]);
          if (!includers.has(b)) includers.set(b, []);
          if (!includers.get(b).includes(rel)) includers.get(b).push(rel);
        }
      }
    }
  }
}

function runClangCheck(rel) {
  const file = path.join(ROOT, rel.split('/').join(path.sep));
  if (!clang) return { status: 'skipped', msg: 'clang not found' };
  if (/\.S$/i.test(rel)) {
    const obj = path.join(os.tmpdir(), 'xv-check-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.o');
    const r = spawnSync(clang, ['-c', '-w', '-target', 'riscv64-unknown-elf', '-o', obj, file], {
      encoding: 'utf8',
      cwd: NEUTRAL_CWD,
      maxBuffer: 16 * 1024 * 1024,
    });
    try {
      fs.unlinkSync(obj);
    } catch {
      /* 临时文件可能未生成 */
    }
    if (r.error) return { status: 'skipped', msg: String(r.error) };
    if (r.status !== 0) return { status: 'err', msg: firstLine(r.stderr) || 'exit ' + r.status };
    return { status: 'ok' };
  }
  if (/\.h$/i.test(rel)) {
    const list = includers.get(path.basename(rel)) || [];
    if (list.length === 0) {
      return { status: 'err', msg: 'header is not included by any .c file; cannot verify in context' };
    }
    let last = null;
    for (const inc of list.slice(0, 3)) {
      const r = checkOnce(inc);
      if (r.status === 'ok') return { status: 'ok', via: inc };
      last = r;
    }
    return { status: 'err', msg: 'via ' + list[0] + ': ' + (last && last.msg ? last.msg : 'failed') };
  }
  return checkOnce(rel);
}

const syntaxCache = new Map();
function checkOnce(rel) {
  if (syntaxCache.has(rel)) return syntaxCache.get(rel);
  const file = path.join(ROOT, rel.split('/').join(path.sep));
  const r = spawnSync(clang, clangArgs(file, rel), {
    encoding: 'utf8',
    cwd: NEUTRAL_CWD,
    maxBuffer: 16 * 1024 * 1024,
  });
  let res;
  if (r.error) res = { status: 'skipped', msg: String(r.error) };
  else if (r.status !== 0) res = { status: 'err', msg: firstLine(r.stderr) || 'exit ' + r.status };
  else res = { status: 'ok' };
  syntaxCache.set(rel, res);
  return res;
}

function firstLine(s) {
  return (s || '').trim().split(/\r?\n/)[0] || '';
}

// ---------- diff ----------
function runGit(args) {
  return spawnSync('git', ['--no-pager', ...args], {
    encoding: 'utf8',
    cwd: NEUTRAL_CWD,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function numstat(baseFile, curFile) {
  const r = runGit(['diff', '--no-index', '--numstat', '--', baseFile, curFile]);
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

// 返回新增/删除的行内容（带新文件行号）
function diffLines(baseFile, curFile) {
  const r = runGit(['diff', '--no-index', '-U0', '--', baseFile, curFile]);
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

const COMMENT_PREFIXES = ['//', '/*', '*'];
function isCommentOrBlank(text) {
  const t = text.trim();
  if (t === '') return true;
  return COMMENT_PREFIXES.some((p) => t.startsWith(p));
}

buildIncluderIndex();

let addedSum = 0;
let deletedNonZero = 0;
let syntaxErr = 0;
let skipped = 0;
let checked = 0;
const problems = [];

for (const rel of rels) {
  const baseFile = path.join(batchDir, rel.split('/').join(path.sep));
  const curFile = path.join(ROOT, rel.split('/').join(path.sep));
  const bExists = fs.existsSync(baseFile);
  const cExists = fs.existsSync(curFile);
  if (!bExists || !cExists) {
    problems.push(`MISSING ${rel} (baseline=${bExists}, current=${cExists})`);
    deletedNonZero++;
    continue;
  }
  const ns = numstat(baseFile, curFile);
  addedSum += ns.added;
  checked++;

  const dl = diffLines(baseFile, curFile);
  deletedNonZero += dl.deleted.filter((s) => s.trim() !== '').length;
  for (const a of dl.added) {
    if (a.text.includes('*/')) {
      problems.push(`CLOSER ${rel}:${a.line} 新增行含 */`);
    } else if (!isCommentOrBlank(a.text)) {
      problems.push(`NONCOMMENT ${rel}:${a.line} ${a.text.slice(0, 80)}`);
    }
  }

  const sc = runClangCheck(rel);
  if (sc.status === 'skipped') {
    skipped++;
    problems.push(`SKIPPED ${rel}: ${sc.msg}`);
  } else if (sc.status === 'err') {
    syntaxErr++;
    problems.push(`SYNTAX ${rel}: ${sc.msg}`);
  }
}

for (const p of problems) console.log(p);
console.log(
  `SUMMARY files=${checked} added=${addedSum} deletedNonZero=${deletedNonZero} skipped=${skipped} syntaxErr=${syntaxErr}`,
);
process.exit(
  checked > 0 && deletedNonZero === 0 && syntaxErr === 0 && skipped === 0 && problems.length === 0 ? 0 : 1,
);
