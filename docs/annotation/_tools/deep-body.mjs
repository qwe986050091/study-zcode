#!/usr/bin/env node
// 内文率（function-body comment rate）度量工具
//
// 定义（按任务口径，DEEP-SPEC v2 补充指标）：
//   内文率 = 函数体内部的中文注释行数 ÷ 函数体内部代码行数
// 只统计「中文注释」（含 CJK 字符）作为本工程新增注释的证据：上游英文 docstring / 英文
// JSDoc 不计入分子，也不计入分母（Python 的 docstring 整段剔除），避免把上游文档算成业绩。
// 分母 = 函数体内部的非空、非整行注释、非 docstring 行。
//
// 与 deep-quality.mjs 的分工：deep-quality 看整文件覆盖度/实质率/解释率/注水率，本工具只看
// 「注释有没有写进函数体、密度够不够」，两者合起来构成验收指标。
//
// 用法：
//   node deep-body.mjs <repo> [--files a,b,c | --file-list f.txt]
//                            [--root src] [--ext .py,.ts] [--exclude glob]
//                            [--json out.json] [--quiet]
//
// 退出码：0 = 度量完成；1 = 读文件/解析失败；2 = 参数错误。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const USAGE = `usage: node deep-body.mjs <repo> [--files a,b,c | --file-list f.txt] [--root src]
       [--ext .py,.ts] [--exclude glob] [--json out.json] [--quiet]`;

const DEFAULT_EXT = ['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0].startsWith('--')) {
  console.error(USAGE);
  process.exit(2);
}
const repo = path.resolve(argv[0]);
const opt = { files: [], fileList: '', root: 'src', ext: DEFAULT_EXT, exclude: [], json: '', quiet: false };
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
  else if (a === '--root') opt.root = need();
  else if (a === '--ext') opt.ext = need().split(',').map((s) => s.trim()).filter(Boolean);
  else if (a === '--exclude') opt.exclude.push(need());
  else if (a === '--json') opt.json = need();
  else if (a === '--quiet') opt.quiet = true;
  else {
    console.error('unknown arg: ' + a);
    process.exit(2);
  }
}
if (!fs.existsSync(repo)) {
  console.error('ERROR: repo not found: ' + repo);
  process.exit(2);
}

function globToRegExp(g) {
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        out += '.*';
        i++;
        if (g[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if ('\\^$.|?+()[]{}'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return new RegExp('^' + out + '$');
}

function walk(dir, out, exts) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error('无法读取目录 ' + dir + ': ' + e.message);
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['target', 'node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.next'].includes(ent.name)) continue;
      walk(p, out, exts);
    } else if (ent.isFile() && exts.some((e) => ent.name.endsWith(e))) out.push(p);
  }
}

function resolveFiles() {
  let list = [];
  if (opt.files.length || opt.fileList) {
    const names = opt.files.slice();
    if (opt.fileList) {
      for (const l of fs.readFileSync(path.resolve(opt.fileList), 'utf8').split(/\r?\n/)) {
        const v = l.trim();
        if (v) names.push(v);
      }
    }
    for (const n of names) {
      const abs = path.resolve(repo, n);
      if (!fs.existsSync(abs)) throw new Error('文件不存在: ' + n);
      list.push(abs);
    }
  } else {
    for (const r of opt.root.split(',').map((s) => s.trim()).filter(Boolean)) {
      const dir = path.join(repo, r);
      if (!fs.existsSync(dir)) throw new Error('源码目录不存在: ' + dir);
      walk(dir, list, opt.ext);
    }
  }
  const exRes = opt.exclude.map(globToRegExp);
  if (exRes.length) {
    list = list.filter((f) => {
      const rel = path.relative(repo, f).replace(/\\/g, '/');
      return !exRes.some((re) => re.test(rel));
    });
  }
  list = [...new Set(list.map((f) => path.resolve(f)))].sort();
  if (!list.length) throw new Error('没有匹配到文件');
  return list;
}

// ---------- Python：缩进扫描函数体 ----------
// 不依赖 python 进程：def/async def 行确定缩进，签名可跨行，以「括号深度归零后的冒号」结束；
// 函数体从下一行开始，直到首个非空且缩进 <= def 缩进的行为止（注释行不结束函数体）。
function pythonFunctions(lines) {
  const funcs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:async\s+)?def\s+[A-Za-z_]\w*\s*\(/);
    if (!m) continue;
    const defIndent = m[1].replace(/\t/g, '    ').length;
    // 找签名结束：括号深度归零且该行以 ':' 结尾
    let depth = 0;
    let sigEnd = i;
    let sawColon = false;
    for (let j = i; j < lines.length; j++) {
      const code = stripPyStrings(lines[j]);
      for (const ch of code) {
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
      }
      const t = code.trim();
      if (depth === 0 && /:\s*(#.*)?$/.test(t)) {
        sigEnd = j;
        sawColon = true;
        break;
      }
      sigEnd = j;
    }
    if (!sawColon) continue;
    let bodyStart = sigEnd + 1;
    while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart++;
    if (bodyStart >= lines.length) continue;
    const firstIndent = indentOf(lines[bodyStart]);
    if (firstIndent <= defIndent) continue; // 单行函数（def f(): pass）或空体
    let bodyEnd = bodyStart;
    for (let j = bodyStart; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === '') {
        bodyEnd = j;
        continue;
      }
      if (indentOf(lines[j]) <= defIndent) break;
      bodyEnd = j;
    }
    funcs.push({ start: bodyStart, end: bodyEnd, defLine: i, defIndent, firstIndent });
  }
  return funcs;
}

function indentOf(line) {
  const m = line.match(/^[ \t]*/);
  return (m ? m[0] : '').replace(/\t/g, '    ').length;
}

// 去掉 Python 字符串字面量内容，避免括号出现在字符串里干扰签名扫描。
function stripPyStrings(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '#') break;
    if (c === '"' || c === "'") {
      const triple = s.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        const close = s.indexOf(triple, i + 3);
        if (close >= 0) {
          i = close + 3;
          out += '""';
          continue;
        }
        out += '""';
        break;
      }
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

// 找函数体开头的 docstring 行区间（0-based 行号，含起止）。
function pythonDocstringLines(lines, fn) {
  const set = new Set();
  let s = fn.start;
  // 跳过函数体开头的空行与注释：注释可以写在 docstring 之前，
  // 若把注释当成"首条语句"，docstring 会漏判并被算进函数体代码行。
  while (
    s <= fn.end &&
    (lines[s].trim() === '' || lines[s].trim().startsWith('#'))
  ) s++;
  if (s > fn.end) return set;
  const m = lines[s].match(/^\s*[rRuUbBfF]{0,2}("""|''')/);
  if (!m) return set;
  const quote = m[1];
  let opened = false;
  for (let j = s; j <= fn.end; j++) {
    set.add(j);
    const body = j === s ? lines[j].slice(lines[j].indexOf(quote) + 3) : lines[j];
    const idx = body.indexOf(quote);
    if (idx >= 0) {
      opened = true;
      break;
    }
    if (j === s) opened = false;
  }
  if (!opened) set.clear(); // 未闭合，按普通代码处理，避免吞掉整个函数
  return set;
}

function measurePython(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const funcs = pythonFunctions(lines);
  const codeSet = new Set();
  const cmtSet = new Set();
  for (const fn of funcs) {
    const doc = pythonDocstringLines(lines, fn);
    // 先按单个函数统计代码行；只有确实包含代码的函数才把注释计入分子，
    // 否则"只有 docstring/注释的抽象方法"会凭空抬高全文件内文率。
    const localCode = [];
    const localCmt = [];
    for (let j = fn.start; j <= fn.end; j++) {
      if (doc.has(j)) continue;
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('#')) {
        if (CJK.test(t)) localCmt.push(j);
      } else {
        localCode.push(j);
      }
    }
    if (localCode.length === 0) continue;
    for (const j of localCode) codeSet.add(j);
    for (const j of localCmt) cmtSet.add(j);
  }
  return { funcs: funcs.length, codeLines: codeSet.size, commentLines: cmtSet.size };
}

// ---------- TypeScript/JavaScript：优先用 typescript 编译器 AST ----------
let ts = null;
let tsLoadNote = '';
function loadTs() {
  if (ts !== null) return ts;
  const candidates = [repo, path.resolve('d:\\code\\_annot_baseline\\tools')];
  for (const c of candidates) {
    try {
      const req = createRequire(path.join(c, '__deep_body_resolver__.js'));
      ts = req('typescript');
      tsLoadNote = 'typescript@' + ts.version;
      return ts;
    } catch {
      /* try next */
    }
  }
  ts = false;
  tsLoadNote = 'unavailable';
  return ts;
}

function measureTs(file, text) {
  const compiler = loadTs();
  if (!compiler) return measureTsRegex(text);
  const sf = compiler.createSourceFile(file, text, compiler.ScriptTarget.Latest, true);
  const lines = text.split('\n');
  const codeSet = new Set();
  const cmtSet = new Set();
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line; // 0-based
  let funcs = 0;
  const visit = (node) => {
    if (
      compiler.isFunctionLike(node) &&
      node.body &&
      compiler.isBlock(node.body)
    ) {
      funcs++;
      const s = lineOf(node.body.getStart(sf));
      const e = lineOf(node.body.getEnd());
      const localCode = [];
      const localCmt = [];
      for (let j = s; j <= e; j++) {
        const t = lines[j].trim();
        if (t === '') continue;
        if (t.startsWith('//')) {
          if (CJK.test(t)) localCmt.push(j);
        } else if (t.startsWith('/*') || t.startsWith('*')) {
          if (CJK.test(t)) localCmt.push(j);
        } else {
          localCode.push(j);
        }
      }
      // 与 Python 同一口径：只有含代码的函数体才把中文注释计入分子。
      if (localCode.length > 0) {
        for (const j of localCode) codeSet.add(j);
        for (const j of localCmt) cmtSet.add(j);
      }
    }
    compiler.forEachChild(node, visit);
  };
  visit(sf);
  return { funcs, codeLines: codeSet.size, commentLines: cmtSet.size };
}

// 无 typescript 时的兜底：按 `{` 配平识别函数体（近似，结果会标注 fallback）。
function measureTsRegex(text) {
  const lines = text.split('\n');
  const bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const s = stripJsStrings(lines[i]);
    const t = s.trim();
    if (/\b(if|for|while|switch|catch|try|with)\b[^;{]*$/.test(t)) continue;
    const isFn =
      /(?:^|\s)(?:async\s+)?function\b[^(]*\([^;]*$/.test(t) ||
      /=>\s*\{\s*$/.test(t) ||
      /^\s*(?:public|private|protected|static\s+)*[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?::[^{]+)?\{\s*$/.test(t) ||
      /^\s*(?:get|set)\s+[A-Za-z_$][\w$]*\s*\([^;]*\)\s*\{\s*$/.test(t);
    if (!isFn || !t.includes('{')) continue;
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length; j++) {
      const code = stripJsStrings(lines[j]);
      for (const ch of code) {
        if (ch === '{') {
          depth++;
          started = true;
        } else if (ch === '}') depth--;
      }
      if (started && depth <= 0) {
        bodies.push([i, j]);
        break;
      }
    }
  }
  const codeSet = new Set();
  const cmtSet = new Set();
  for (const [s, e] of bodies) {
    for (let j = s; j <= e; j++) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) {
        if (CJK.test(t)) cmtSet.add(j);
      } else codeSet.add(j);
    }
  }
  return { funcs: bodies.length, codeLines: codeSet.size, commentLines: cmtSet.size, fallback: true };
}

function stripJsStrings(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '/') break;
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

// ---------- 主流程 ----------
let files;
try {
  files = resolveFiles();
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}

const rows = [];
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
  const ext = path.extname(abs).toLowerCase();
  let m;
  if (ext === '.py') m = measurePython(text);
  else m = measureTs(abs, text);
  const rate = m.codeLines ? (m.commentLines / m.codeLines) * 100 : null;
  rows.push({ path: rel, funcs: m.funcs, codeLines: m.codeLines, commentLines: m.commentLines, bodyRate: rate, fallback: !!m.fallback });
}

const fmt = (v) => (v === null || v === undefined ? '-' : v.toFixed(1));
const totalCode = rows.reduce((n, r) => n + r.codeLines, 0);
const totalCmt = rows.reduce((n, r) => n + r.commentLines, 0);
const totalRate = totalCode ? (totalCmt / totalCode) * 100 : null;

if (!opt.quiet) {
  console.log('bodyRate%\tbodyCmt\tbodyCode\tfuncs\tpath');
  for (const r of rows) {
    console.log(`${fmt(r.bodyRate)}\t${r.commentLines}\t${r.codeLines}\t${r.funcs}\t${r.path}${r.fallback ? '  [regex-fallback]' : ''}`);
  }
}
console.log(`SUMMARY files=${rows.length} funcs=${rows.reduce((n, r) => n + r.funcs, 0)} bodyCode=${totalCode} bodyCmt=${totalCmt} bodyRate=${fmt(totalRate)}% ts=${tsLoadNote || 'n/a'}`);

if (opt.json) {
  fs.writeFileSync(
    path.resolve(opt.json),
    JSON.stringify(
      {
        repo,
        summary: {
          files: rows.length,
          funcs: rows.reduce((n, r) => n + r.funcs, 0),
          bodyCode: totalCode,
          bodyComments: totalCmt,
          bodyRate: totalRate,
        },
        rows,
      },
      null,
      2,
    ),
  );
}

if (errors > 0) {
  console.error(`FAIL: ${errors} 个文件读取失败`);
  process.exit(1);
}
