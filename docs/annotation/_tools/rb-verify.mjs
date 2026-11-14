// 批次注释校验脚本（Rust / cberner/redb）
// 用法：node d:\code\_annot_baseline\rb-verify.mjs <批次名>
//   批次名可带或不带 RB- 前缀，例如 RB-redb-b1 / redb-b1
// 口径：
//   1) 逐文件 git --no-pager diff --no-index --numstat <基线> <工作区>：删除列必须为 0，
//      另要求新增的每一行都是纯注释行（trim 后以 // 开头），防止误改代码
//   2) 逐文件语法检查：把工作区文件复制到临时目录后跑
//        rustfmt --edition 2024 --emit stdout <tmpfile>
//      - 实测（2026-11-05，本机 rustfmt 1.9.0-stable / rustc 1.90）：
//        * 本仓库 Cargo.toml 用 edition = "2024"，且 db.rs 含 let chains，
//          用 --edition 2021 会对合法代码报 "let chains are only allowed in Rust 2024 or later"，
//          因此必须用 2024。
//        * 合法文件：退出码 0，只把格式化结果写到 stdout。
//        * 语法错误：退出码 1，stderr 形如 "error: this file contains an unclosed delimiter"。
//      - 只在临时副本上跑；--emit stdout 是只读模式，绝不使用 --write / cargo fmt。
//      - rustfmt 会顺着 lib.rs 里的 mod 声明递归解析子模块，所以临时副本必须是整棵 src 的镜像，
//        否则会报 "failed to resolve mod `backends`"（这不是语法错误）。
//      - rustfmt 的定位顺序（见 findRustfmt）：RUSTFMT 环境变量（一旦设置即为强制覆盖，含空串）
//        → `rustup which rustfmt` 解析出的真实 toolchain 路径 → shim / PATH → ~/.cargo/bin。
//        之所以优先用 `rustup which`：本仓库被 rust-toolchain 钉在 1.90，而 rustup 的 shim 按 cwd
//        选工具链，在仓库目录里调用 shim 会失败；真实 toolchain 路径不受 cwd 影响。
//      - rustfmt 不可用时**不再静默降级**：每个文件都记一条 SYNTAX 失败并计入 syntaxErr 与 skipped，
//        最终以非零码退出（历史教训：假绿会掩盖整批未做语法校验）。
// 输出末行：SUMMARY files=<n> added=<n> deletedNonZero=<n> syntaxErr=<n> skipped=<n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = 'd:\\code\\opensource\\redb';
const BASE = 'd:\\code\\_annot_baseline';

const rawArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!rawArg) {
  console.error('usage: node rb-verify.mjs <batch>');
  process.exit(2);
}
const batch = rawArg.replace(/^RB-/, '');
const batchDir = path.join(BASE, 'RB-' + batch);
if (!fs.existsSync(batchDir)) {
  console.error('baseline not found: ' + batchDir);
  process.exit(2);
}

const manifest = path.join(batchDir, '_files.txt');
const rels = fs.existsSync(manifest)
  ? fs
      .readFileSync(manifest, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split(/\s+/)[0])
  : [];

function works(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

// `rustup which rustfmt` 在**临时目录**里执行：rustup 按 cwd 选工具链，
// 在仓库目录里会命中 rust-toolchain 钉住的 1.90（该工具链没有 rustfmt 组件）。
// 拿到的是真实 toolchain 里的二进制路径，后续调用不再受 cwd 影响。
function rustupWhichRustfmt() {
  const r = spawnSync('rustup', ['which', 'rustfmt'], { encoding: 'utf8', cwd: os.tmpdir() });
  if (r.error || r.status !== 0) return null;
  const out = (r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length ? out[out.length - 1] : null;
}

function findRustfmt() {
  // RUSTFMT 一旦被设置（哪怕是空串）就视为强制覆盖，不再回退到自动探测：
  // 这样「工具链缺失」的对照实验才可复现，也避免使用者以为指定了路径却被悄悄换掉。
  const override = process.env.RUSTFMT;
  if (override !== undefined) {
    const forced = override.trim();
    return forced && works(forced) ? forced : null;
  }
  const fromRustup = rustupWhichRustfmt();
  if (fromRustup && works(fromRustup)) return fromRustup;
  const cands = ['rustfmt', path.join(os.homedir(), '.cargo', 'bin', 'rustfmt.exe')];
  for (const c of cands) {
    if (works(c)) return c;
  }
  return null;
}

const rustfmt = findRustfmt();
if (!rustfmt) {
  console.error('ERROR: rustfmt not found; syntax check cannot be skipped silently (see findRustfmt order)');
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-parse-'));
// 镜像策略：按清单里出现的「顶层路径段」逐个镜像，而不是写死 src。
// 原因：本仓库现在有两类批次——主 crate 的 src/**，以及 crates/**（Python 绑定、derive、
// bench）与根 build.rs。rustfmt 解析 lib.rs 时会递归加载 `mod` 指向的子模块，
// 只镜像 src 会让 crates 批次里的文件找不到镜像、被误判成语法错误。
const topLevels = new Set(rels.map((r) => r.replace(/\\/g, '/').split('/')[0]));
// 兜底：老批次清单可能不含某些 mod 子文件，保留 src 整棵镜像的行为。
topLevels.add('src');
for (const top of topLevels) {
  const from = path.join(ROOT, top);
  if (!fs.existsSync(from)) continue;
  const to = path.join(tmpDir, top);
  fs.cpSync(from, to, { recursive: true });
}

function syntaxCheck(file) {
  // rustfmt 缺失 = 该文件未做语法校验，必须按失败处理（不能返回 ok:true 造成假绿）
  if (!rustfmt) return { ok: false, skipped: true, msg: 'rustfmt unavailable, syntax not verified' };
  const tmp = path.join(tmpDir, file);
  // 镜像是在脚本启动时拍的快照，不再逐文件复制/删除：删掉子模块会让后续文件的 mod 解析失败。
  const r = spawnSync(rustfmt, ['--edition', '2024', '--emit', 'stdout', tmp], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { ok: false, msg: String(r.error) };
  const errText = (r.stderr || '').trim();
  if (r.status !== 0 || /error:/i.test(errText)) {
    const first = errText.split(/\r?\n/).find((l) => /error/i.test(l)) || errText.split(/\r?\n/)[0];
    return { ok: false, msg: first || 'exit ' + r.status };
  }
  return { ok: true };
}

function numstat(baseFile, curFile) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--numstat', '--', baseFile, curFile], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
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

// 取 diff 的新增行，校验「每一行都是 // 注释」，并统计含 */ 的行（块注释提前闭合风险）。
function addedLines(baseFile, curFile) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', baseFile, curFile], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) out.push(line.slice(1));
  }
  return out;
}

let addedSum = 0;
let deletedNonZero = 0;
let syntaxErr = 0;
let nonComment = 0;
let starSlash = 0;
let checked = 0;
let skippedSyntax = 0;
const problems = [];

for (const rel of rels) {
  const baseFile = path.join(batchDir, rel);
  const curFile = path.join(ROOT, rel);
  if (!fs.existsSync(baseFile) || !fs.existsSync(curFile)) {
    problems.push(`MISSING ${rel} (baseline=${fs.existsSync(baseFile)}, current=${fs.existsSync(curFile)})`);
    deletedNonZero++;
    continue;
  }
  const { added, deleted } = numstat(baseFile, curFile);
  addedSum += added;
  checked++;
  if (deleted > 0) {
    deletedNonZero++;
    problems.push(`DELETED ${deleted}  ${rel}`);
  }
  for (const l of addedLines(baseFile, curFile)) {
    if (!l.trim().startsWith('//')) {
      nonComment++;
      problems.push(`NONCOMMENT ${rel}: ${l.slice(0, 100)}`);
    }
    if (l.includes('*/')) {
      starSlash++;
      problems.push(`STARSLASH ${rel}: ${l.slice(0, 100)}`);
    }
  }
  const sc = syntaxCheck(rel);
  if (sc.skipped) skippedSyntax++;
  if (!sc.ok) {
    syntaxErr++;
    problems.push(`SYNTAX ${rel}: ${sc.msg}`);
  }
}

for (const p of problems) console.log(p);
if (skippedSyntax) console.log(`NOTE syntax check skipped for ${skippedSyntax} file(s)`);
if (nonComment) console.log(`NOTE nonComment=${nonComment} (added lines that are not // comments)`);
if (starSlash) console.log(`NOTE starSlash=${starSlash} (added lines containing */)`);
console.log(
  `SUMMARY files=${checked} added=${addedSum} deletedNonZero=${deletedNonZero} syntaxErr=${syntaxErr} skipped=${skippedSyntax}`,
);
process.exit(
  deletedNonZero === 0 && syntaxErr === 0 && nonComment === 0 && starSlash === 0 && skippedSyntax === 0
    ? 0
    : 1,
);
