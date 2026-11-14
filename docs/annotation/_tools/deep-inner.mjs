#!/usr/bin/env node
// 内文率度量（claude-code-main 回炉专用）
//
// 背景：deep-quality.mjs 的「注释行 / 代码行」会把仓库上游自带的英文 JSDoc 一起算进去，
// 在 clone 下来的第三方代码里会虚高。本脚本只统计**函数体内部**的注释与代码：
//   - 函数体：由 { } 界定、且左花括号前是函数签名 / 箭头函数 / 方法声明的块；
//   - 内文注释行：位于函数体内部的整行注释，且（含中文）或（相对基线为新增行）；
//   - 内文代码行：位于函数体内部的非空、非整行注释行；
//   - 内文率 = 内文注释行 / 内文代码行。
//
// 用法：
//   node deep-inner.mjs <repo> [--files a,b,c | --file-list f.txt]
//        [--baseline <dir>] [--json out.json] [--quiet] [--top N]
//   --baseline  基线快照目录（保持相对路径）；出现时只把「新增注释行」计入新增口径，
//               并额外输出 newInnerComment / newInnerRate。
//   退出码：0 完成；1 读文件失败；2 参数错误。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
// fail-closed：找不到 TypeScript 解析器直接非零退出，禁止「跳过即通过」
function loadTs() {
  const candidates = [
    path.join(process.cwd(), 'node_modules', 'typescript', 'lib', 'typescript.js'),
    'd:/code/_annot_baseline/tools/node_modules/typescript/lib/typescript.js',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  console.error('ERROR: 找不到 TypeScript 解析器（node_modules/typescript 或 _annot_baseline/tools）');
  process.exit(1);
}
const ts = loadTs();

const argv = process.argv.slice(2);
if (!argv.length || argv[0].startsWith('--')) {
  console.error('usage: node deep-inner.mjs <repo> [--files a,b,c | --file-list f.txt] [--baseline dir] [--json out.json] [--quiet] [--top N]');
  process.exit(2);
}
const repo = path.resolve(argv[0]);
const opt = { files: [], fileList: '', baseline: '', json: '', quiet: false, top: 10 };
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  const need = () => {
    const v = argv[++i];
    if (v === undefined) {
      console.error('ERROR: ' + a + ' 缺少参数值');
      process.exit(2);
    }
    return v;
  };
  if (a === '--files') opt.files = need().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--file-list') opt.fileList = need();
  else if (a === '--baseline') opt.baseline = need();
  else if (a === '--json') opt.json = need();
  else if (a === '--quiet') opt.quiet = true;
  else if (a === '--top') opt.top = Number(need());
  else {
    console.error('unknown arg: ' + a);
    process.exit(2);
  }
}
if (!fs.existsSync(repo)) {
  console.error('ERROR: repo not found: ' + repo);
  process.exit(2);
}

function resolveFiles() {
  let names = opt.files.slice();
  if (opt.fileList) {
    const txt = fs.readFileSync(path.resolve(opt.fileList), 'utf8');
    for (const l of txt.split(/\r?\n/)) if (l.trim()) names.push(l.trim());
  }
  if (!names.length) throw new Error('需要 --files 或 --file-list');
  const out = [];
  for (const n of names) {
    const abs = path.resolve(repo, n);
    if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + n);
    out.push(abs);
  }
  return out;
}

// 去掉字符串内容，保留注释标记，便于同一行同时判注释与花括号。
function stripStrings(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < s.length) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (s[i] === q) {
          i++;
          break;
        }
        i++;
      }
      out += '""';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const CJK = /[\u3400-\u9fff]/;

// 把源码切成逐行模型：blank / comment / code；并计算每行的块注释状态。
function parseLines(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const rows = [];
  let inBlock = false;
  for (const line of lines) {
    const t = line.trim();
    if (t === '') {
      rows.push({ kind: 'blank', text: line });
      continue;
    }
    if (inBlock) {
      rows.push({ kind: 'comment', text: line, content: t, block: true });
      if (t.includes('*/')) inBlock = false;
      continue;
    }
    if (t.startsWith('/*')) {
      rows.push({ kind: 'comment', text: line, content: t, block: true });
      if (!t.includes('*/')) inBlock = true;
      continue;
    }
    if (t.startsWith('//')) {
      rows.push({ kind: 'comment', text: line, content: t.replace(/^\/{2,}\s?/, '') });
      continue;
    }
    rows.push({ kind: 'code', text: line });
  }
  return rows;
}

// 用 TypeScript AST 找所有函数体（含箭头函数、方法、构造函数、匿名回调），
// 取 body 覆盖的行号并集作为「内文」范围。比花括号启发式可靠，能正确处理
// 多行返回类型、参数解构与对象字面量。
function functionInterior(text, filePath) {
  const kind = /\.tsx$/i.test(filePath) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, kind);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) {
    throw new Error('语法解析失败: ' + sf.parseDiagnostics[0].messageText);
  }
  const interior = new Set();
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const visit = (node) => {
    if (node.body && ts.isBlock(node.body)) {
      const start = lineOf(node.body.getStart(sf));
      const end = lineOf(node.body.getEnd());
      for (let l = start; l <= end; l++) interior.add(l);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return interior;
}

function runGitDiffNoIndex(baseFile, curFile) {
  const r = spawnSync('git', ['--no-pager', 'diff', '--no-index', '-U0', '--', baseFile, curFile], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error('git diff --no-index 失败: ' + String(r.error));
  return r.stdout || '';
}

// 解析 -U0 diff 的新增行号集合。
function addedLineNumbers(diffText) {
  const out = new Set();
  let newNo = 0;
  let inHunk = false;
  for (const raw of diffText.split(/\r?\n/)) {
    if (!inHunk) {
      const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) {
        inHunk = true;
        newNo = Number(h[1]);
      }
      continue;
    }
    if (raw.startsWith('@@')) {
      const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newNo = h ? Number(h[1]) : newNo;
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.add(newNo);
      newNo++;
      continue;
    }
    if (raw.startsWith('-') || raw.startsWith('\\')) continue;
    if (raw.startsWith(' ')) {
      newNo++;
      continue;
    }
    inHunk = false;
  }
  return out;
}

let files;
try {
  files = resolveFiles();
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}

const rowsOut = [];
let errors = 0;
for (const abs of files) {
  const rel = path.relative(repo, abs).replace(/\\/g, '/');
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    console.error('ERROR: 无法读取 ' + rel + ': ' + e.message);
    errors++;
    continue;
  }
  const rows = parseLines(text);
  let interior;
  try {
    interior = functionInterior(text, abs);
  } catch (e) {
    console.error('ERROR: 语法解析失败 ' + rel + ': ' + e.message);
    errors++;
    continue;
  }

  let added = null;
  if (opt.baseline) {
    const baseFile = path.join(path.resolve(opt.baseline), rel);
    if (!fs.existsSync(baseFile)) {
      console.error('ERROR: 基线缺文件 ' + baseFile);
      errors++;
      continue;
    }
    added = addedLineNumbers(runGitDiffNoIndex(baseFile, abs));
  }

  let innerComment = 0;
  let innerCode = 0;
  let innerCjkComment = 0;
  let newInnerComment = 0;
  let newInnerCode = 0;
  for (let i = 0; i < rows.length; i++) {
    if (!interior.has(i)) continue;
    const r = rows[i];
    if (r.kind === 'blank') continue;
    const isNew = added ? added.has(i + 1) : false;
    if (r.kind === 'comment') {
      const cjk = CJK.test(r.content ?? '');
      if (cjk || isNew) {
        innerComment++;
        if (cjk) innerCjkComment++;
        if (isNew) newInnerComment++;
      }
    } else {
      innerCode++;
      if (isNew) newInnerCode++;
    }
  }
  const pct = (a, b) => (b === 0 ? null : (a / b) * 100);
  rowsOut.push({
    path: rel,
    innerCode,
    innerComment,
    innerCjkComment,
    innerRate: pct(innerComment, innerCode),
    newInnerCode: added ? newInnerCode : null,
    newInnerComment: added ? newInnerComment : null,
    newInnerRate: added ? pct(newInnerComment, newInnerCode) : null,
  });
}

const fmt = (v) => (v === null || v === undefined ? '-' : v.toFixed(1));
if (!opt.quiet) {
  console.log('innerCode\tinnerComment\tinnerRate%\tnewCmt\tnewCode\tnewRate%\tpath');
  for (const r of rowsOut) {
    console.log(
      `${r.innerCode}\t${r.innerComment}\t${fmt(r.innerRate)}\t${r.newInnerComment ?? '-'}\t${r.newInnerCode ?? '-'}\t${fmt(r.newInnerRate)}\t${r.path}`,
    );
  }
}
const sum = (f) => rowsOut.reduce((n, r) => n + f(r), 0);
const totalCode = sum((r) => r.innerCode);
const totalComment = sum((r) => r.innerComment);
const totalNewComment = sum((r) => r.newInnerComment ?? 0);
const totalNewCode = sum((r) => r.newInnerCode ?? 0);
console.log(
  `INNER files=${rowsOut.length} innerCode=${totalCode} innerComment=${totalComment} innerRate=${fmt(totalCode ? (totalComment / totalCode) * 100 : null)}%` +
    (opt.baseline ? ` newInnerComment=${totalNewComment} newInnerCode=${totalNewCode} newInnerRate=${fmt(totalNewCode ? (totalNewComment / totalNewCode) * 100 : null)}%` : ''),
);
if (opt.json) {
  fs.writeFileSync(
    path.resolve(opt.json),
    JSON.stringify(
      {
        repo,
        baseline: opt.baseline || null,
        summary: {
          files: rowsOut.length,
          innerCode: totalCode,
          innerComment: totalComment,
          innerRate: totalCode ? (totalComment / totalCode) * 100 : null,
          newInnerComment: opt.baseline ? totalNewComment : null,
          newInnerCode: opt.baseline ? totalNewCode : null,
          newInnerRate: opt.baseline && totalNewCode ? (totalNewComment / totalNewCode) * 100 : null,
        },
        rows: rowsOut,
      },
      null,
      2,
    ),
  );
}
if (errors) {
  console.error('FAIL: ' + errors + ' 个文件处理失败');
  process.exit(1);
}
