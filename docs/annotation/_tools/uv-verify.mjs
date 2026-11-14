// uvicorn 批次注释校验脚本（Python 版）
// 用法：node d:\code\_annot_baseline\uv-verify.mjs <批次名>
//   批次名可带或不带 UV- 前缀，例如 uvicorn-b1 / UV-uvicorn-b1
// 口径（全部 fail-closed，任何一步无法判定即报错退出，绝不"跳过算通过"）：
//   0) 基线目录、_files.txt 必须存在且非空，否则 exit 2
//   1) python 必须真实可用（区分"未安装"与"应用商店空壳"），否则 exit 2
//   2) 逐文件 git --no-pager diff --no-index 对比基线，删除行必须为 0
//      git 状态只允许 0（无差异）/1（有差异），其它状态或 spawn 失败一律计为 ioErr
//   3) 新增行只允许「注释行（可带缩进）或空行」，违例计入 nonCommentAdd
//   4) 逐文件 python ast.parse 语法检查，失败计入 syntaxErr
// 输出末行：SUMMARY files=<n> added=<sum> deletedNonZero=<count> syntaxErr=<count> nonCommentAdd=<count> ioErr=<count>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ROOT/BASE/PYTHON 支持环境变量覆盖，仅用于负向自测（把脚本指向临时的假仓库，
// 避免为了验证"能不能报错"去改真实仓库源码）。正常使用不要设置这些变量。
const ROOT = process.env.UV_ROOT || 'd:\\code\\opensource\\uvicorn';
const BASE = process.env.UV_BASE || 'd:\\code\\_annot_baseline';
const PYTHON = process.env.UV_PYTHON || 'python';

const rawArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!rawArg) {
  console.error('usage: node uv-verify.mjs <batch>');
  process.exit(2);
}
const batchName = rawArg.replace(/^UV-/, '');
const batchDir = path.join(BASE, 'UV-' + batchName);
if (!fs.existsSync(batchDir)) {
  console.error('ERROR baseline directory not found: ' + batchDir);
  process.exit(2);
}

const manifest = path.join(batchDir, '_files.txt');
const AST_CHECK = path.join(BASE, '_ast_check.py');
// 洞 1：清单缺失时此前会退化成空数组，循环不执行，最后输出全 0 并 exit 0（假绿）。
// 现在清单缺失或解析后为空都显式报错退出。
if (!fs.existsSync(manifest)) {
  console.error('ERROR manifest not found: ' + manifest);
  process.exit(2);
}
const rels = fs
  .readFileSync(manifest, 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter(Boolean)
  // 每行格式为 "<相对路径> <行数>"，去掉末尾行数列
  .map((s) => s.replace(/\s+\d+$/, ''))
  .filter(Boolean);
if (rels.length === 0) {
  console.error('ERROR manifest is empty: ' + manifest);
  process.exit(2);
}

// 洞 4：python 不可用时，此前每个文件都只是 syntaxErr，无法区分"没装"与"商店空壳"。
// 先做一次可用性探测，失败直接 exit 2 并把原因说清楚，避免把环境问题误报成语法错误。
// 统一用 `python -S <helper>` 调用：
//   -S 跳过 site 初始化（本机某个 site 定制会导致启动卡死），ast 属标准库不受影响；
//   用独立 .py 文件而非 `-c`，规避不同 shell 对内联代码引号/转义的处理差异。
// 所有 spawn 都带 timeout，环境异常时宁可报错也不要无限挂住。
const SPAWN_TIMEOUT = 120000;

function runPython(args) {
  return spawnSync(PYTHON, ['-S', AST_CHECK, ...args], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: SPAWN_TIMEOUT,
  });
}

function describeSpawnFailure(r) {
  if (!r.error) return '未知错误';
  if (r.error.code === 'ENOENT') return 'python 未安装，或不在 PATH 中（spawn ENOENT）';
  if (r.error.code === 'ETIMEDOUT') return `python 执行超时（>${SPAWN_TIMEOUT / 1000}s），环境异常`;
  return 'python 无法启动: ' + r.error.message;
}

function probePython() {
  if (!fs.existsSync(AST_CHECK)) {
    return { ok: false, msg: '缺少辅助脚本 ' + AST_CHECK };
  }
  const r = runPython(['--version']);
  if (r.error) return { ok: false, msg: describeSpawnFailure(r) };
  if (r.status !== 0) {
    const txt = ((r.stdout || '') + (r.stderr || '')).trim();
    if (/Microsoft Store|Windows Store|App Execution Alias|应用商店|不是内部或外部命令|python\.exe.*not found/i.test(txt)) {
      return {
        ok: false,
        msg: 'python 指向 Windows 应用商店占位空壳（App Execution Alias），并非真实解释器：' + txt.split(/\r?\n/)[0],
      };
    }
    return { ok: false, msg: `python 执行失败 status=${r.status}: ` + txt.split(/\r?\n/).slice(-1)[0] };
  }
  return { ok: true, msg: 'python ' + (r.stdout || '').trim() };
}

const py = probePython();
if (!py.ok) {
  console.error('ERROR ' + py.msg);
  process.exit(2);
}
console.log('python=' + py.msg);

// 一次 git diff 同时产出「增删计数」与「新增行内容」，避免两次调用结果不一致。
// 洞 2：区分 git 自身失败与"确实没有差异"，失败不再用 NaN→0 兜底。
function diffFile(baseFile, curFile) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '--no-color', '-U0', '--', baseFile, curFile], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: SPAWN_TIMEOUT,
  });
  if (r.error) return { ok: false, msg: 'spawn git 失败: ' + r.error.message };
  // --no-index 语义：0 = 两文件相同，1 = 有差异；其余状态说明 git 本身出错
  if (r.status !== 0 && r.status !== 1) {
    const tail = ((r.stderr || '') + (r.stdout || '')).trim().split(/\r?\n/).slice(-1)[0];
    return { ok: false, msg: `git 退出状态 ${r.status}: ${tail}` };
  }
  const addedLines = [];
  let deleted = 0;
  let inHunk = false;
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // 文件头（index/---/+++）不算内容行
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    if (line.startsWith('+')) {
      addedLines.push(line.slice(1));
    } else if (line.startsWith('-')) {
      deleted++;
    }
  }
  if (r.status === 1 && addedLines.length === 0 && deleted === 0) {
    // 有差异却解析不出任何增删行，说明补丁格式超出预期，不能当作 0/0 通过
    return { ok: false, msg: 'git 报告有差异但补丁解析结果为空' };
  }
  return { ok: true, addedLines, deleted };
}

// 仅用 ast.parse 判断语法，不 import、不执行目标文件，避免引入运行期副作用
function parseOk(file) {
  const r = runPython([file]);
  if (r.error) return { ok: false, msg: describeSpawnFailure(r) };
  if (r.status !== 0) {
    const msg = ((r.stderr || '') + (r.stdout || '')).trim().split(/\r?\n/).slice(-1)[0];
    return { ok: false, msg };
  }
  return { ok: true, msg: '' };
}

// 洞 3：脚本一直声称"新增行只允许 # 注释或空行"，但从未真正断言。
// 允许缩进，因为函数体内部的注释必须缩进；除此之外的任何新增行都算违例。
function isCommentOrBlank(text) {
  return /^\s*#/.test(text) || /^\s*$/.test(text);
}

let addedSum = 0;
let deletedNonZero = 0;
let syntaxErr = 0;
let nonCommentAdd = 0;
let ioErr = 0;
let checked = 0;
const problems = [];

for (const rel of rels) {
  const baseFile = path.join(batchDir, rel);
  const curFile = path.join(ROOT, rel);
  if (!fs.existsSync(baseFile) || !fs.existsSync(curFile)) {
    problems.push(`MISSING ${rel} (baseline=${fs.existsSync(baseFile)}, current=${fs.existsSync(curFile)})`);
    ioErr++;
    continue;
  }
  const d = diffFile(baseFile, curFile);
  if (!d.ok) {
    problems.push(`GIT ${rel}: ${d.msg}`);
    ioErr++;
    continue;
  }
  checked++;
  addedSum += d.addedLines.length;
  if (d.deleted !== 0) {
    deletedNonZero++;
    problems.push(`DELETED ${d.deleted}  ${rel}`);
  }
  const bad = d.addedLines.filter((l) => !isCommentOrBlank(l));
  if (bad.length > 0) {
    nonCommentAdd += bad.length;
    const sample = bad[0].trim().slice(0, 80);
    problems.push(`NONCOMMENT ${bad.length}  ${rel}  e.g. ${JSON.stringify(sample)}`);
  }
  const p = parseOk(curFile);
  if (!p.ok) {
    syntaxErr++;
    problems.push(`SYNTAX ${rel}: ${p.msg}`);
  }
}

for (const p of problems) console.log(p);
console.log(
  `SUMMARY files=${checked} added=${addedSum} deletedNonZero=${deletedNonZero} syntaxErr=${syntaxErr} nonCommentAdd=${nonCommentAdd} ioErr=${ioErr}`,
);
process.exit(deletedNonZero === 0 && syntaxErr === 0 && nonCommentAdd === 0 && ioErr === 0 ? 0 : 1);
