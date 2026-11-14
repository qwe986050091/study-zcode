// 批次注释校验脚本（Rust / astral-sh/uv，UVR-B1 起）
// 用法：node d:\code\_annot_baseline\uvr-verify.mjs [批次名] [--crate <crate 目录名>]
//   默认批次 UVR-B1；也可传 UV-B1 / UVR-B1-B2 这类前缀变体。
//   --crate 指定要镜像的 crate（默认 uv-resolver），用于跨 crate 的批次。
//   基线文件优先取 <批次>/orig/<相对路径>；不存在时回退到 <批次>/<相对路径>
//   （深度注释批次与 deep-density.mjs 共用同一份基线布局）。
// 口径（fail-closed，任何一步无法判定都算失败，绝不"跳过即通过"）：
//   0) 基线目录 + _files.txt 必须存在且非空，否则 exit 2
//   1) rustfmt 必须可解析（RUSTFMT 环境变量 → `rustup which rustfmt` → PATH → ~/.cargo/bin）；
//      找不到时每个文件都记 SYNTAX 失败并计入 skipped，最终非零退出。
//      为什么不用 PATH 上的 rustup shim：仓库 rust-toolchain.toml 把工具链钉在 1.99，
//      而该工具链不含 rustfmt 组件；shim 按 cwd 选工具链，所以在仓库目录里调用会失败。
//      `rustup which rustfmt` 在临时目录执行，拿到的是真实 toolchain 二进制路径，不受 cwd 影响。
//   2) 逐文件 `git diff --no-index --numstat` 对比基线：删除列必须为 0；
//      git 退出码只允许 0/1，其它状态视为 IO 失败（不折算成 0 差异）。
//   3) 新增行必须是注释：行首 `//`、块注释内部、或以 `/*` 开头的块注释起始行；
//      块注释上下文按当前文件的完整行号扫描判定（不是按文本匹配，避免重复行误判）。
//      新增行里出现 `*/` 视为"提前闭合块注释"的风险，单独计数。
//   4) 语法：把整棵 crates/uv-resolver/src 镜像到临时目录，再对镜像文件跑
//        rustfmt --edition 2024 --config-path <中性配置> --config skip_children=true --emit stdout
//      - 必须用 --config-path 指向中性配置：仓库 .rustfmt.toml 含 nightly 选项，直接读会报错；
//      - 必须 skip_children=true：否则 rustfmt 会顺着 mod 声明把整棵子模块树都解析进来；
//      - 镜像整棵 src 仍然需要：单文件解析时 rustfmt 会加载 `mod xxx;` 指向的文件；
//      - --emit stdout 是只读模式，绝不 --write，也不碰仓库文件。
// 输出末行：SUMMARY files=<n> added=<n> deletedNonZero=<n> syntaxErr=<n> skipped=<n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = 'd:\\code\\opensource\\uv';
const BASE = 'd:\\code\\_annot_baseline';
const NEUTRAL = path.join(BASE, 'rustfmt-neutral.toml');
const SPAWN_TIMEOUT = 120000;

const args = process.argv.slice(2);
const rawArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--crate');
const crateIdx = args.indexOf('--crate');
const crate = crateIdx >= 0 ? args[crateIdx + 1] : 'uv-resolver';
const batch = (rawArg || 'UVR-B1').replace(/^UV-/, '');
const batchDir = path.join(BASE, batch.startsWith('UVR-') ? batch : 'UVR-' + batch);
if (!fs.existsSync(batchDir)) {
  console.error('ERROR baseline directory not found: ' + batchDir);
  process.exit(2);
}
if (!fs.existsSync(NEUTRAL)) {
  console.error('ERROR neutral rustfmt config not found: ' + NEUTRAL);
  process.exit(2);
}

const manifest = path.join(batchDir, '_files.txt');
if (!fs.existsSync(manifest)) {
  console.error('ERROR manifest not found: ' + manifest);
  process.exit(2);
}
const rels = fs
  .readFileSync(manifest, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  // 每行格式 "<相对路径> <行数>"：去掉末尾行数列
  .map((s) => s.replace(/\s+\d+$/, ''))
  .filter(Boolean);
if (rels.length === 0) {
  console.error('ERROR manifest is empty: ' + manifest);
  process.exit(2);
}

function works(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 30000 });
  return !r.error && r.status === 0;
}

// RUSTFMT 一旦被设置（含空串）即强制覆盖，便于复现"工具链缺失"的负向实验。
function findRustfmt() {
  const override = process.env.RUSTFMT;
  if (override !== undefined) {
    const forced = override.trim();
    return forced && works(forced) ? forced : null;
  }
  const r = spawnSync('rustup', ['which', 'rustfmt'], { encoding: 'utf8', cwd: os.tmpdir(), timeout: 30000 });
  if (!r.error && r.status === 0) {
    const out = (r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    const p = out.length ? out[out.length - 1] : null;
    if (p && works(p)) return p;
  }
  const cands = ['rustfmt', path.join(os.homedir(), '.cargo', 'bin', 'rustfmt.exe')];
  for (const c of cands) {
    if (works(c)) return c;
  }
  return null;
}

const rustfmt = findRustfmt();
if (!rustfmt) {
  console.error('ERROR rustfmt not found; syntax check cannot be skipped silently (see findRustfmt)');
}

// 镜像整棵 <crate>/src 与该 crate 根目录下的 .rs（后者用于 build.rs 批次）。
// rustfmt 解析 lib.rs / 各 mod 时会递归加载子模块文件，
// 缺文件会被误判成语法错误（"failed to resolve mod ..."）。
// crate 可传逗号分隔的多个名字，镜像布局统一为 <tmp>/<crate>/...，
// 因此 relInSrc 只需剥掉前缀 crates/，多 crate 批次不需要额外参数。
const SRC_ROOT = path.join(ROOT, 'crates', crate);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uvr-parse-'));
const crateList = crate
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
for (const c of crateList) {
  const crateRoot = path.join(ROOT, 'crates', c);
  if (!fs.existsSync(crateRoot)) continue;
  const dst = path.join(tmpDir, c);
  fs.mkdirSync(dst, { recursive: true });
  const srcDir = path.join(crateRoot, 'src');
  if (fs.existsSync(srcDir)) fs.cpSync(srcDir, path.join(dst, 'src'), { recursive: true });
  for (const f of fs.readdirSync(crateRoot)) {
    const p = path.join(crateRoot, f);
    if (f.endsWith('.rs') && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dst, f));
  }
}

function syntaxCheck(rel) {
  if (!rustfmt) return { ok: false, skipped: true, msg: 'rustfmt unavailable, syntax not verified' };
  const relInSrc = rel.replace(/^crates[\\/]/, '');
  const tmp = path.join(tmpDir, relInSrc);
  if (!fs.existsSync(tmp)) return { ok: false, msg: 'mirrored file missing: ' + relInSrc };
  const r = spawnSync(
    rustfmt,
    ['--edition', '2024', '--config-path', NEUTRAL, '--config', 'skip_children=true', '--emit', 'stdout', tmp],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: SPAWN_TIMEOUT },
  );
  if (r.error) {
    const suffix = r.error.code === 'ETIMEDOUT' ? ' (timeout)' : '';
    return { ok: false, msg: String(r.error.message || r.error) + suffix };
  }
  const errText = (r.stderr || '').trim();
  if (r.status !== 0 || /error:/i.test(errText)) {
    const first = errText.split(/\r?\n/).find((l) => /error/i.test(l)) || errText.split(/\r?\n/)[0];
    return { ok: false, msg: first || 'exit ' + r.status };
  }
  return { ok: true };
}

// 一次 diff 同时拿新增行号与删除行数：用 hunk 头计算新文件行号，
// 这样"哪些行是新增的"是行号级别的事实，后续再结合整文件扫描判断注释上下文。
function diffFile(baseFile, curFile) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--no-color', '-U0', '--', baseFile, curFile], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: SPAWN_TIMEOUT,
  });
  if (r.error) return { ok: false, msg: 'spawn git failed: ' + r.error.message };
  if (r.status !== 0 && r.status !== 1) {
    const tail = ((r.stderr || '') + (r.stdout || '')).trim().split(/\r?\n/).slice(-1)[0];
    return { ok: false, msg: `git exit ${r.status}: ${tail}` };
  }
  const added = []; // {lineNo, text}
  let deleted = 0;
  let newLine = 0;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) {
      added.push({ lineNo: newLine, text: line.slice(1) });
      newLine++;
    } else if (line.startsWith('-')) {
      deleted++;
    }
  }
  if (r.status === 1 && added.length === 0 && deleted === 0) {
    return { ok: false, msg: 'git reported differences but patch parsed empty' };
  }
  return { ok: true, added, deleted };
}

// 扫一遍当前文件，判定每个行号是否处于注释上下文：
//   - `//` 行（含 `///` / `//!`）
//   - 块注释内部（含起始行与结束行）
// 只对新增行做断言；块注释状态必须从文件头开始累积，不能从 hunk 中间猜。
function commentLines(file) {
  const text = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const kind = new Array(text.length + 1).fill('code');
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const t = text[i].trim();
    if (inBlock) {
      kind[i + 1] = 'block';
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('//')) {
      kind[i + 1] = 'line';
      continue;
    }
    if (t.startsWith('/*')) {
      kind[i + 1] = 'block';
      // 单行块注释 /* ... */ 立即闭合；否则进入块状态
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
  }
  return { text, kind };
}

let addedSum = 0;
let deletedNonZero = 0;
let syntaxErr = 0;
let nonComment = 0;
let starSlash = 0;
let skipped = 0;
let checked = 0;
const problems = [];

for (const rel of rels) {
  const origFile = path.join(batchDir, 'orig', rel);
  const flatFile = path.join(batchDir, rel);
  const baseFile = fs.existsSync(origFile) ? origFile : flatFile;
  const curFile = path.join(ROOT, rel);
  if (!fs.existsSync(baseFile) || !fs.existsSync(curFile)) {
    problems.push(`MISSING ${rel} (baseline=${fs.existsSync(baseFile)}, current=${fs.existsSync(curFile)})`);
    deletedNonZero++;
    continue;
  }
  const d = diffFile(baseFile, curFile);
  if (!d.ok) {
    problems.push(`GIT ${rel}: ${d.msg}`);
    deletedNonZero++;
    continue;
  }
  checked++;
  addedSum += d.added.length;
  if (d.deleted !== 0) {
    deletedNonZero++;
    problems.push(`DELETED ${d.deleted}  ${rel}`);
  }
  const { kind } = commentLines(curFile);
  for (const a of d.added) {
    const k = kind[a.lineNo] || 'code';
    if (k === 'code') {
      nonComment++;
      problems.push(`NONCOMMENT ${rel}:${a.lineNo}: ${a.text.slice(0, 100)}`);
    }
    if (a.text.includes('*/') && k === 'block') {
      starSlash++;
      problems.push(`STARSLASH ${rel}:${a.lineNo}: ${a.text.slice(0, 100)}`);
    }
  }
  const sc = syntaxCheck(rel);
  if (sc.skipped) skipped++;
  if (!sc.ok) {
    syntaxErr++;
    problems.push(`SYNTAX ${rel}: ${sc.msg}`);
  }
}

for (const p of problems) console.log(p);
if (skipped) console.log(`NOTE syntax check skipped for ${skipped} file(s)`);
if (nonComment) console.log(`NOTE nonComment=${nonComment} (added lines outside any comment)`);
if (starSlash) console.log(`NOTE starSlash=${starSlash} (added block-comment lines containing */)`);
console.log(
  `SUMMARY files=${checked} added=${addedSum} deletedNonZero=${deletedNonZero} syntaxErr=${syntaxErr} skipped=${skipped}`,
);
process.exit(deletedNonZero === 0 && syntaxErr === 0 && nonComment === 0 && starSlash === 0 && skipped === 0 ? 0 : 1);
