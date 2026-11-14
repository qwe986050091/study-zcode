#!/usr/bin/env node
// LangGraph 深度注释批次校验器（fail-closed）
// 用法: node lg-verify.mjs <批次名> [仓库根目录] [--threshold 30] [--density-only]
//
// 批次目录约定: d:\code\_annot_baseline\<批次名>\
//   orig\<相对路径>   批次开工前的基线快照
//   _files.txt        每行: 相对路径<TAB>基线行数
//
// 校验项（任一不满足即非零退出）:
//   1) deletedNonZero   : git diff --no-index --numstat 删除列必须为 0
//   2) nonCommentAdded  : 新增行 trim 后必须以 # 开头（或为空行）
//   3) starSlash        : 新增注释行内不得出现 */（Python 无块注释，防串味）
//   4) syntaxErrorFiles : python -S 解释器 + ast.parse 解析失败数；解释器不可用视为全量失败
//   5) density          : 每个文件 注释行/代码行 >= threshold（默认 30）
//
// 语法校验说明: 用 `python -S -c "import ast; ast.parse(...)"` 只解析不执行。
// 直接 `python -S <file>` 会执行模块顶层代码（含 import 副作用），不符合"语法校验"语义。

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const batch = argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (!batch) {
  console.error('用法: node lg-verify.mjs <批次名> [仓库根目录] [--threshold 30] [--density-only]');
  process.exit(2);
}
const positional = argv.filter((a) => !a.startsWith('--'));
const repoRoot = positional[1] ?? 'd:/code/opensource/langgraph';
const threshold = Number(
  argv.includes('--threshold') ? argv[argv.indexOf('--threshold') + 1] : 30,
);
const densityOnly = argv.includes('--density-only');

const BASE_ROOT = 'd:/code/_annot_baseline';
const batchDir = path.join(BASE_ROOT, batch);
const origRoot = path.join(batchDir, 'orig');
const filesListPath = path.join(batchDir, '_files.txt');

if (!existsSync(filesListPath)) {
  console.error(`FAIL-CLOSED: 找不到基线清单 ${filesListPath}`);
  process.exit(1);
}

const entries = readFileSync(filesListPath, 'utf8')
  .split('\n')
  .map((l) => l.replace(/\r$/, ''))
  .filter((l) => l.trim())
  .map((line) => {
    const [rel, lines] = line.split('\t');
    return { rel: rel.replace(/\\/g, '/'), baselineLines: Number(lines) };
  });

function measureText(text) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let blank = 0;
  let comment = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') blank++;
    else if (t.startsWith('#')) comment++;
  }
  const total = lines.length;
  const code = total - blank - comment;
  const density = code === 0 ? Infinity : comment / code;
  return { total, blank, comment, code, density };
}

function runDiff(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status === 1 && typeof e.stdout === 'string') return e.stdout;
    throw new Error(`git 执行失败: ${e.message}`);
  }
}

// ---------------- Python 解释器探测（区分三种不可用原因） ----------------
const PY_PROBE = 'import sys;sys.stdout.write("%d.%d" % sys.version_info[:2])';
function probePython(p) {
  if (!p || !existsSync(p)) return { ok: false, reason: '不存在' };
  if (/WindowsApps[\\/]python(3)?\.exe$/i.test(p)) {
    return { ok: false, reason: '商店空壳(stub)' };
  }
  try {
    const out = execFileSync(p, ['-S', '-c', PY_PROBE], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (/^3\./.test(out.trim())) return { ok: true, version: out.trim() };
    return { ok: false, reason: `非 Python3: ${out.trim().slice(0, 40)}` };
  } catch (e) {
    if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') return { ok: false, reason: '探测超时' };
    return { ok: false, reason: `执行失败: ${String(e.message).slice(0, 80)}` };
  }
}

function resolvePython() {
  const candidates = [];
  if (process.env.LG_PYTHON) candidates.push(process.env.LG_PYTHON);
  candidates.push('C:\\Python314\\python.exe', 'C:\\Python313\\python.exe', 'C:\\Python312\\python.exe');
  try {
    const where = execFileSync('where.exe', ['python'], { encoding: 'utf8', timeout: 10000 });
    candidates.push(...where.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    // where 找不到也不致命，继续用固定候选
  }
  const tried = [];
  for (const c of [...new Set(candidates)]) {
    const r = probePython(c);
    if (r.ok) return { python: c, version: r.version, tried };
    tried.push(`${c} -> ${r.reason}`);
  }
  return { python: null, tried };
}

// ---------------- 增量校验 ----------------
const details = [];
let addedTotal = 0;
let deletedNonZero = 0;
let commentViolations = 0;
let starSlash = 0;
const diffFailures = [];

if (!densityOnly) {
  for (const { rel, baselineLines } of entries) {
    const baseFile = path.join(origRoot, rel);
    const curFile = path.join(repoRoot, rel);
    if (!existsSync(baseFile) || !existsSync(curFile)) {
      diffFailures.push(`${rel} (缺少基线或当前文件)`);
      continue;
    }
    const numstat = runDiff(['diff', '--no-index', '--numstat', '--', baseFile, curFile]).trim();
    let added = 0;
    let deleted = 0;
    if (numstat) {
      const [a, d] = numstat.split('\n')[0].split('\t');
      added = a === '-' ? 0 : Number(a);
      deleted = d === '-' ? 0 : Number(d);
    }
    addedTotal += added;
    if (deleted > 0) deletedNonZero++;

    const patch = runDiff(['diff', '--no-index', '-U0', '--no-color', '--', baseFile, curFile]);
    const badLines = [];
    for (const line of patch.split('\n')) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const body = line.replace(/\r$/, '').slice(1);
      const t = body.trim();
      if (t !== '' && !t.startsWith('#')) badLines.push(body);
      if (t.startsWith('#') && t.includes('*/')) starSlash++;
    }
    if (badLines.length > 0) {
      commentViolations += badLines.length;
      details.push(
        `  ! ${rel}: ${badLines.length} 行新增内容不是注释，首例: ${JSON.stringify(badLines[0].slice(0, 100))}`,
      );
    }
    details.push(`  ${rel}: baseline=${baselineLines} added=${added} deleted=${deleted}`);
  }
}

// ---------------- 语法校验 ----------------
let syntaxErr = 0;
if (!densityOnly) {
  const py = resolvePython();
  if (!py.python) {
    // fail-closed: 解释器不可用 = 无法证明语法正确
    syntaxErr = entries.length;
    details.push(`  ! Python 解释器不可用，计入 ${entries.length} 个 syntaxErr`);
    for (const t of py.tried) details.push(`    tried: ${t}`);
  } else {
    details.push(`  python = ${py.python} (${py.version})`);
    const parseCode =
      'import ast,sys;ast.parse(sys.stdin.buffer.read().decode("utf-8"))';
    for (const { rel } of entries) {
      const curFile = path.join(repoRoot, rel);
      if (!existsSync(curFile)) {
        syntaxErr++;
        details.push(`  ! ${rel}: 文件缺失，计入 syntaxErr`);
        continue;
      }
      const text = readFileSync(curFile, 'utf8');
      const r = spawnSync(py.python, ['-S', '-c', parseCode], {
        input: text,
        encoding: 'utf8',
        timeout: 30000,
      });
      if (r.error && r.error.code === 'ETIMEDOUT') {
        syntaxErr++;
        details.push(`  ! ${rel}: 语法校验超时(30s)`);
      } else if (r.status !== 0) {
        syntaxErr++;
        const msg = String(r.stderr || r.error?.message || '').trim().split('\n').slice(-1)[0];
        details.push(`  ! ${rel}: 语法错误: ${msg.slice(0, 160)}`);
      }
    }
  }
}

// ---------------- 密度 ----------------
const densities = [];
let below = 0;
for (const { rel } of entries) {
  const curFile = path.join(repoRoot, rel);
  if (!existsSync(curFile)) continue;
  const m = measureText(readFileSync(curFile, 'utf8'));
  densities.push({ rel, ...m });
  if (m.code > 0 && m.density * 100 < threshold) {
    below++;
    details.push(
      `  ! ${rel}: 密度 ${(m.density * 100).toFixed(2)}% < ${threshold}% (注释 ${m.comment} / 代码 ${m.code})`,
    );
  }
}
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(2) : 'n/a');
const sorted = densities.map((d) => d.density).filter(Number.isFinite).sort((a, b) => a - b);
const minD = sorted.length ? sorted[0] : NaN;
const medD = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;

for (const d of details) console.log(d);

const files = entries.length;
const ok =
  deletedNonZero === 0 &&
  commentViolations === 0 &&
  starSlash === 0 &&
  syntaxErr === 0 &&
  diffFailures.length === 0 &&
  below === 0;
console.log(
  `SUMMARY batch=${batch} files=${files} added=${addedTotal} deletedNonZero=${deletedNonZero} ` +
    `nonCommentAdded=${commentViolations} starSlash=${starSlash} syntaxErrorFiles=${syntaxErr} ` +
    `diffFailures=${diffFailures.length} densityBelow=${below} minDensity=${pct(minD)} medianDensity=${pct(medD)}`,
);
console.log(ok ? 'RESULT PASS' : 'RESULT FAIL');
process.exit(ok ? 0 : 1);
