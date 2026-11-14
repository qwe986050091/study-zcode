// 跨仓字符串内部注释扫描：找出「注释样式的新增行落在多行字符串字面量内部」的情况。
// 支持：TS/JS(TS AST)、Python(三引号)、Rust(普通串+raw 串)、Go(反引号)、C/C++(普通串+raw 串)。
// 用法：node zc-stringscan.mjs <repoRoot> [子目录...]
// 输出：TSV —— repo<TAB>file<TAB>line<TAB>stringType<TAB>inHead
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = process.argv[2];
const roots = process.argv.slice(3);
const tsRoot = 'D:/code/ZCode';
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', 'out', 'bundled-agents', '.next', 'coverage', 'vendor', '.tox', '.trae', '_annot_baseline', '_annot_work', '_annot_check', '_annot_apply_b14b', '_tmp_annot_commit', '.screenshots']);
const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.py', '.rs', '.go', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp']);

let ts = null;
async function getTs() {
  if (!ts) ts = (await import('file:///' + path.join(tsRoot, 'node_modules/typescript/lib/typescript.js').replace(/\\/g, '/'))).default;
  return ts;
}

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(p, out);
    } else if (e.isFile() && EXTS.has(path.extname(e.name).toLowerCase()) && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
}

// 按语言只认一种注释前缀：TS/Rust/Go/C 认 `//`，Python 认 `#`。
// 否则 JS 模板里的 shell 片段（`# 注释`）会被大面积误报。
function lineRanges(text, start, end, type, hits) {
  const prefix = type === 'py-triple' ? '#' : '//';
  const before = text.slice(0, start);
  const baseLine = before.split('\n').length;
  const chunk = text.slice(start, end);
  chunk.split('\n').forEach((line, i) => {
    if (i === 0) return; // 首行是开引号所在行，通常不可能整行以注释符开头
    if (line.trim().startsWith(prefix)) {
      hits.push({ line: baseLine + i, type });
    }
  });
}

async function scanTs(file, text, hits) {
  const T = await getTs();
  const sf = T.createSourceFile(file, text, T.ScriptTarget.Latest, true, file.endsWith('.tsx') || file.endsWith('.jsx') ? T.ScriptKind.TSX : T.ScriptKind.TS);
  const visit = (node) => {
    const k = node.kind;
    if ((k === T.SyntaxKind.StringLiteral || k === T.SyntaxKind.NoSubstitutionTemplateLiteral) && node.getChildren(sf).length === 0) {
      const raw = node.getText(sf);
      if (raw.includes('\n')) lineRanges(text, node.getStart(sf), node.getEnd(), k === T.SyntaxKind.StringLiteral ? 'js-string' : 'template', hits);
    }
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);
}

function scanPython(text, hits) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      const start = i;
      i += quote.length;
      while (i < n) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text.startsWith(quote, i)) { i += quote.length; break; }
        if (!triple && text[i] === '\n') break;
        i++;
      }
      if (triple) lineRanges(text, start, i, 'py-triple', hits);
      continue;
    }
    i++;
  }
}

function scanGo(text, hits) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text.startsWith('//', i)) { while (i < n && text[i] !== '\n') i++; continue; }
    if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (text[i] === '`') {
      const start = i; const e = text.indexOf('`', i + 1); const end = e < 0 ? n : e + 1;
      lineRanges(text, start, end, 'go-raw', hits); i = end; continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i]; let j = i + 1;
      while (j < n) { if (text[j] === '\\') { j += 2; continue; } if (text[j] === q) { j++; break; } if (text[j] === '\n') break; j++; }
      i = j; continue;
    }
    i++;
  }
}

function scanRust(text, hits) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text.startsWith('//', i)) { while (i < n && text[i] !== '\n') i++; continue; }
    if (text.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < n && depth > 0) { if (text.startsWith('/*', i)) { depth++; i += 2; } else if (text.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      continue;
    }
    // raw string: r"..." / r#"..."# / br#"..."#
    const raw = /^(?:b)?r(#*)"/.exec(text.slice(i, i + 8));
    if (raw && (i === 0 || !/[A-Za-z0-9_]/.test(text[i - 1]))) {
      const hashes = raw[1];
      const open = i + raw[0].length;
      const closer = '"' + hashes;
      const e = text.indexOf(closer, open);
      const end = e < 0 ? n : e + closer.length;
      lineRanges(text, i, end, 'rust-raw', hits);
      i = end; continue;
    }
    if (text[i] === '"') {
      const start = i; let j = i + 1;
      while (j < n) { if (text[j] === '\\') { j += 2; continue; } if (text[j] === '"') { j++; break; } j++; }
      lineRanges(text, start, j, 'rust-string', hits);
      i = j; continue;
    }
    if (text[i] === "'") {
      // 字符字面量 vs 生命周期：'x' 形式才按字符处理
      if (text[i + 2] === "'") { i += 3; continue; }
      i++; continue;
    }
    i++;
  }
}

function scanC(text, hits) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text.startsWith('//', i)) { while (i < n && text[i] !== '\n') i++; continue; }
    if (text.startsWith('/*', i)) { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    // C++ raw string: R"delim( ... )delim"
    const raw = /^R"([^()\\\s]{0,16})\(/.exec(text.slice(i, i + 20));
    if (raw) {
      const closer = ')' + raw[1] + '"';
      const e = text.indexOf(closer, i + raw[0].length);
      const end = e < 0 ? n : e + closer.length;
      lineRanges(text, i, end, 'cpp-raw', hits);
      i = end; continue;
    }
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i]; const start = i; let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === q) { j++; break; }
        j++;
      }
      if (q === '"') lineRanges(text, start, j, 'c-string', hits);
      i = j; continue;
    }
    i++;
  }
}

const headCache = new Map();
function headText(rel) {
  if (headCache.has(rel)) return headCache.get(rel);
  let content = null;
  try {
    content = execFileSync('git', ['-C', repo, 'show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { content = null; }
  headCache.set(rel, content);
  return content;
}

const files = [];
for (const r of roots.length ? roots : ['.']) walk(path.join(repo, r), files);
const rows = [];
let scanned = 0;
for (const abs of files) {
  const rel = path.relative(repo, abs).replace(/\\/g, '/');
  const ext = path.extname(abs).toLowerCase();
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
  const hits = [];
  try {
    if (['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'].includes(ext)) await scanTs(rel, text, hits);
    else if (ext === '.py') scanPython(text, hits);
    else if (ext === '.rs') scanRust(text, hits);
    else if (ext === '.go') scanGo(text, hits);
    else scanC(text, hits);
  } catch (e) { continue; }
  scanned++;
  for (const h of hits) {
    const head = headText(rel);
    const lineText = text.split('\n')[h.line - 1].trim();
    const status = head === null ? 'untracked' : head.includes(lineText) ? 'in-head' : 'new';
    rows.push({ rel, ...h, status });
  }
}

for (const r of rows) {
  console.log([path.basename(repo), r.rel, r.line, r.type, r.status].join('\t'));
}
const count = (s) => rows.filter((r) => r.status === s).length;
console.log(`SUMMARY repo=${path.basename(repo)} files=${scanned} hits=${rows.length} new=${count('new')} inHead=${count('in-head')} untracked=${count('untracked')}`);
