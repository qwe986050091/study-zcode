#!/usr/bin/env node
// 注释批次校验器（复用型）：node gm-verify.mjs <批次名> [仓库根目录]
//
// 设计要点（fail-closed）：
// 1. 逐文件用 `git diff --no-index --numstat` 比对 基线快照 vs 当前文件，
//    统计 added / deleted；任何 deleted > 0 即视为破坏性改动。
// 2. 用 `git diff --no-index -U0` 取出所有新增行，校验「新增行只能是注释或空行」。
// 3. 用 TypeScript compiler API 做语法解析（只看 parseDiagnostics，不做类型检查）。
//    解析器缺失 / 解析抛错 / 单文件解析失败，一律计入 syntaxErr 并以非零码退出，
//    绝不出现「找不到工具就当通过」。
//
// 退出码：0 = 全部通过；1 = 存在删除行 / 非注释新增 / 语法错 / 工具缺失。

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const batch = process.argv[2];
if (!batch) {
  console.error('用法: node gm-verify.mjs <批次名> [仓库根目录]');
  process.exit(2);
}

const BASE_ROOT = 'd:/code/_annot_baseline';
const batchDir = path.join(BASE_ROOT, batch);
const origRoot = path.join(batchDir, 'orig');
const repoRoot = process.argv[3] ?? 'd:/code/opensource/gemini-cli';
const filesListPath = path.join(batchDir, '_files.txt');

if (!existsSync(filesListPath)) {
  console.error(`FAIL-CLOSED: 找不到基线清单 ${filesListPath}`);
  process.exit(1);
}

// _files.txt 格式：相对路径<TAB>行数
const entries = readFileSync(filesListPath, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)
  .map((line) => {
    const [rel, lines] = line.split('\t');
    return { rel: rel.replace(/\\/g, '/'), baselineLines: Number(lines) };
  });

function runDiff(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // git diff --no-index 在存在差异时退出码为 1，这里是有意义的输出
    if (e.status === 1 && typeof e.stdout === 'string') return e.stdout;
    throw new Error(`git 执行失败: ${e.message}`);
  }
}

function isCommentOrBlank(rawLine) {
  const t = rawLine.trim();
  if (t === '') return true;
  return (
    t.startsWith('//') ||
    t.startsWith('/*') ||
    t.startsWith('*/') ||
    t.startsWith('*')
  );
}

const details = [];
let addedTotal = 0;
let deletedNonZero = 0;
let commentViolations = 0;
const diffFailures = [];

for (const { rel, baselineLines } of entries) {
  const baseFile = path.join(origRoot, rel);
  const curFile = path.join(repoRoot, rel);

  if (!existsSync(baseFile) || !existsSync(curFile)) {
    diffFailures.push(`${rel} (缺少基线或当前文件)`);
    continue;
  }

  const numstat = runDiff([
    'diff',
    '--no-index',
    '--numstat',
    '--',
    baseFile,
    curFile,
  ]).trim();

  let added = 0;
  let deleted = 0;
  if (numstat) {
    const first = numstat.split('\n')[0];
    const [a, d] = first.split('\t');
    added = a === '-' ? 0 : Number(a);
    deleted = d === '-' ? 0 : Number(d);
  }
  addedTotal += added;
  if (deleted > 0) deletedNonZero++;

  // 取新增行原文做注释校验
  const patch = runDiff([
    'diff',
    '--no-index',
    '-U0',
    '--no-color',
    '--',
    baseFile,
    curFile,
  ]);
  const badLines = [];
  for (const line of patch.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    if (!isCommentOrBlank(body)) badLines.push(body);
  }
  if (badLines.length > 0) {
    commentViolations += badLines.length;
    details.push(
      `  ! ${rel}: ${badLines.length} 行新增内容不是注释，首例: ${JSON.stringify(badLines[0].slice(0, 120))}`,
    );
  }

  details.push(
    `  ${rel}: baseline=${baselineLines} added=${added} deleted=${deleted}`,
  );
}

// ---------------- 语法校验（TypeScript compiler API） ----------------
// 解析器查找顺序：显式 TS_PATH > 仓库内 node_modules > 本地工具目录。
// 全部找不到时视为 fail-closed，而不是静默跳过语法校验。
const tsCandidates = [
  process.env.TS_PATH,
  path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'typescript.js'),
  path.join(BASE_ROOT, 'tools', 'node_modules', 'typescript', 'lib', 'typescript.js'),
].filter(Boolean);
let ts;
let tsLoadError;
try {
  const tsPath = tsCandidates.find((p) => existsSync(p));
  if (!tsPath) throw new Error(`typescript 未安装，已查找: ${tsCandidates.join(', ')}`);
  const mod = await import(pathToFileURL(tsPath).href);
  ts = mod.default ?? mod;
  if (typeof ts?.createSourceFile !== 'function') {
    throw new Error(`typescript 模块缺少 createSourceFile: ${tsPath}`);
  }
} catch (e) {
  tsLoadError = e;
}

let syntaxErr = 0;
if (tsLoadError) {
  // fail-closed：解析器不可用 = 所有文件都无法证明语法正确
  syntaxErr = entries.length;
  details.push(`  ! 解析器不可用，计入 ${entries.length} 个 syntaxErr: ${tsLoadError.message}`);
} else {
  for (const { rel } of entries) {
    const curFile = path.join(repoRoot, rel);
    if (!existsSync(curFile)) {
      syntaxErr++;
      details.push(`  ! ${rel}: 文件缺失，计入 syntaxErr`);
      continue;
    }
    try {
      const text = readFileSync(curFile, 'utf8');
      const kind = rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
      const sf = ts.createSourceFile(curFile, text, ts.ScriptTarget.Latest, true, kind);
      const diags = sf.parseDiagnostics ?? [];
      if (diags.length > 0) {
        syntaxErr++;
        details.push(
          `  ! ${rel}: ${diags.length} 处语法错误，首例: ${ts.flattenDiagnosticMessageText(diags[0].messageText, ' ')}`,
        );
      }
    } catch (e) {
      syntaxErr++;
      details.push(`  ! ${rel}: 解析抛错，计入 syntaxErr: ${e.message}`);
    }
  }
}

for (const d of details) console.log(d);

const files = entries.length;
const ok = deletedNonZero === 0 && commentViolations === 0 && syntaxErr === 0 && diffFailures.length === 0;
console.log(`SUMMARY batch=${batch} files=${files} added=${addedTotal} deletedNonZero=${deletedNonZero} syntaxErr=${syntaxErr} commentViolations=${commentViolations} diffFailures=${diffFailures.length}`);
console.log(ok ? 'RESULT PASS' : 'RESULT FAIL');
process.exit(ok ? 0 : 1);
